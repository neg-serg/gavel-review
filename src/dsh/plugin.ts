/**
 * dsh（DeepSeek Harness）接入适配器：Cordis 插件模块。
 *
 * 约定与 dsh 工具插件一致：
 * - 具名导出 name / inject / Config / apply，由 Cordis loader 装载
 *   （加载器取 `exports.default ?? exports`，无 default 时使用模块命名空间，
 *   再经 `ctx.registry.plugin()` 按 apply/inject/Config/name 装配）；
 * - apply(ctx, config) 内通过 ctx.tools.register(defineTool(...)) 注册工具，
 *   注册即效果，卸载自动回滚；
 * - 工具内部通过 ctx.llm 流式接口完成多视角模型调用（透镜并行扇出）。
 *
 * 本模块仅在 dsh 环境被加载；独立 CLI 不经过本模块。
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import type { ReviewReport } from '../core/types.ts';
import { DEFAULTS, runReview } from '../core/engine.ts';
import { JsonlDocket } from '../core/docket.ts';
import { generateRules, loadRules, saveRules } from '../core/suppress.ts';
import { renderMarkdown } from '../core/report.ts';
import type { LlmClient } from '../core/types.ts';

/** 插件名（用于日志与诊断）。 */
export const name = 'gavel';

/** 依赖的服务：工具注册表与模型通道。 */
export const inject = ['tools', 'llm'];

/** 部署级配置（cordis.patch.yml 中 gavel 行的 config 字段）。 */
export const Config = z.object({
  /** 注册到 ctx.tools 的工具名。 */
  toolName: z.string().default('gavel_review'),
  /** 模型提供方路由；留空则跟随当前 agent。 */
  provider: z.string().default(''),
  /** 模型名；留空则跟随当前 agent。 */
  model: z.string().default(''),
  /** 启用的透镜。 */
  lenses: z.array(z.string()).default(['correctness', 'security', 'maintainability']),
  /** 是否默认执行深度复核。 */
  deep: z.boolean().default(false),
  /** 是否写案卷与历史对照。 */
  history: z.boolean().default(true),
  /** 案卷与规则文件目录。 */
  historyDir: z.string().default('.gavel'),
  /** 每个透镜的上下文上限（字符）。 */
  maxCharsPerLens: z.number().default(DEFAULTS.maxCharsPerLens),
  /** 每个透镜最多报告条数。 */
  maxFindingsPerLens: z.number().default(DEFAULTS.maxFindingsPerLens),
  /** 单次透镜模型调用的输出上限（token）。 */
  maxTokens: z.number().default(DEFAULTS.maxTokens),
});

/** 解析后的配置类型（与 Config schema 字段一一对应）。 */
export interface GavelConfig {
  toolName: string;
  provider: string;
  model: string;
  lenses: string[];
  deep: boolean;
  history: boolean;
  historyDir: string;
  maxCharsPerLens: number;
  maxFindingsPerLens: number;
  maxTokens: number;
}

/** 通过 ctx.llm 流式接口实现的 LlmClient。 */
function createDshLlmClient(
  ctx: Context,
  provider: string,
  model: string,
  defaultMaxTokens: number,
): LlmClient {
  return {
    async complete({ system, user, maxTokens, temperature, signal }) {
      let text = '';
      const stream = ctx.llm.stream({
        provider,
        model,
        system,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: user }],
            source: { kind: 'plugin', plugin: 'gavel-review' },
          }),
        ],
        maxTokens: maxTokens ?? defaultMaxTokens,
        temperature,
        signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
        } else if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
            throw new Error(`模型调用失败：${chunk.reason.failure.message}`);
          }
        }
      }
      if (!text.trim()) throw new Error('模型返回空内容');
      return { text };
    },
  };
}

/** 注册 gavel_review 工具并挂载全部效果。 */
export function apply(ctx: Context, config: GavelConfig): void {
  const toolName = config.toolName;
  ctx.tools.register(
    defineTool({
      name: toolName,
      description:
        '对抗式多视角代码审查（只读）。传入 git diff 文本或文件路径，' +
        '从正确性 / 安全性 / 可维护性等多个攻击视角并行审查，跨视角合并去重，' +
        '按严重度分级输出问题清单、证据与修复建议；可选生成抑制规则防止同类问题反复上报。' +
        '不修改任何代码。适合在合并、提交或重构后调用。',
      parameters: {
        diff: {
          type: 'string',
          description: '统一 diff 文本（建议 `git diff --unified=8` 输出）。与 paths 至少提供其一。',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '待审查的文件路径列表（整文件审查）。与 diff 至少提供其一。',
        },
        lenses: {
          type: 'array',
          items: { type: 'string', enum: ['correctness', 'security', 'maintainability'] },
          description: '启用视角；默认全部（correctness/security/maintainability）。',
        },
        deep: {
          type: 'boolean',
          description: '是否执行串行深度复核（对候选问题做挑战式再验证）；默认取部署配置。',
        },
        emitRules: {
          type: 'boolean',
          description: '为达到「必须修复」级别的问题生成抑制规则并写入规则文件（默认 false）。',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: renderMarkdown(value as unknown as ReviewReport) },
        ],
      },
      execute(args, exec) {
        const diffText =
          typeof args.diff === 'string' && args.diff.trim() ? args.diff : undefined;
        const paths =
          Array.isArray(args.paths) && args.paths.length > 0
            ? args.paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            : undefined;
        if (!diffText && (!paths || paths.length === 0)) {
          throw new Error(`${toolName}: 需要提供 diff 或 paths（至少其一）`);
        }
        const scope = diffText
          ? ({ kind: 'diff', diffText } as const)
          : ({ kind: 'paths', paths: paths! } as const);

        const provider = config.provider || exec.agent?.options.provider || 'deepseek-official';
        const model = config.model || exec.agent?.options.model || 'deepseek-v4-flash';
        const llm = createDshLlmClient(ctx, provider, model, config.maxTokens);

        const rulesFile = join(config.historyDir, 'rules.json');
        const rules = loadRules(rulesFile);
        const history = config.history ? new JsonlDocket(config.historyDir) : undefined;

        return runReview(
          {
            scope,
            lenses:
              Array.isArray(args.lenses) && args.lenses.length > 0
                ? args.lenses
                : config.lenses, // 原样传递，由引擎校验未知透镜 id
            deep: typeof args.deep === 'boolean' ? args.deep : config.deep,
            model: { provider, model },
            maxTokens: config.maxTokens,
            maxCharsPerLens: config.maxCharsPerLens,
            maxFindingsPerLens: config.maxFindingsPerLens,
            rules,
            rulesFile,
            history,
            signal: exec.signal,
          },
          { llm },
        ).then((report) => {
          if (args.emitRules === true) {
            const existing = loadRules(rulesFile);
            const fresh = generateRules(
              report.findings.concat(report.suppressed.map((s) => s.finding)),
              'required',
              existing,
            );
            if (fresh.length > 0) {
              try {
                saveRules(rulesFile, existing.concat(fresh));
                report.generatedRules = fresh;
                report.rulesFile = rulesFile;
              } catch (error) {
                console.warn(
                  `gavel: 抑制规则写入失败（不影响本次审查）: ${(error as Error).message}`,
                );
              }
            }
          }
          return report;
        });
      },
    }),
  );
}
