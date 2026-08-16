/**
 * gavel 命令行入口（独立模式）。
 *
 * 子命令：
 *   review   （默认）执行对抗式审查
 *   history  查看案卷（最近记录 / 统计）
 *   rules    管理抑制规则（列表 / 添加 / 删除）
 *
 * 模型配置优先顺序：命令行参数 > 环境变量 > 内置默认。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewReport, SeverityLevel, SuppressionRule } from './core/types.ts';
import { ENGINE_VERSION, runReview } from './core/engine.ts';
import { createHttpClient } from './llm/http.ts';
import { JsonlDocket, summarize } from './core/docket.ts';
import { generateRules, loadRules, maxRuleSeq, saveRules } from './core/suppress.ts';
import { renderMarkdown } from './core/report.ts';
import { severityRank } from './core/severity.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_PROVIDER = 'deepseek-official';

interface CliOptions {
  diff?: string;
  paths: string[];
  base?: string;
  lenses?: string[];
  deep: boolean;
  emitRules: boolean;
  history: boolean;
  historyDir: string;
  rulesFile?: string;
  out?: string;
  jsonOut?: string;
  model: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  maxTokens?: number;
  maxChars?: number;
  maxFindings?: number;
  failOn?: SeverityLevel;
  quiet: boolean;
}

function usage(): string {
  return `gavel ${ENGINE_VERSION} —— 对抗式多视角代码审查

用法：
  gavel review [选项]                执行审查（review 可省略）
  gavel history --last <n> | --stats 查看案卷
  gavel rules --list | --add <key> <file> | --drop <id>   管理抑制规则
  gavel --help | --version

审查范围（三选一，互斥）：
  --diff <path|- >   统一 diff 文本文件（- 表示读 stdin）
  --path <path>      直接审查指定文件（可重复）
  --base <ref>       运行 git diff --unified=8 <ref>，如 --base HEAD~1

透镜与深度：
  --lens <a,b>       启用透镜子集：correctness,security,maintainability
                     （含无效 id 时报错退出）
  --deep             执行串行深度复核（挑战式再验证）

抑制与历史：
  --emit-rules       为达标问题生成抑制规则并写入规则文件
  --rules <path>     规则文件路径（默认 <history-dir>/rules.json）
  --no-history       不写案卷、不做历史对照
  --history-dir <d>  案卷目录（默认 .gavel）

输出：
  --out <path>       Markdown 报告输出路径（默认打印到 stdout）
  --json-out <path>  JSON 报告输出路径（默认不输出）
  --fail-on <level>  若存在达到该级别的问题，退出码为 2（blocker/required/recommended/optional/informational）
  --quiet            仅输出结论摘要

模型：
  --model <id>      模型名（默认 deepseek-chat）
  --provider <p>    提供方标识（默认 deepseek-official，仅用于报告）
  --base-url <url>  OpenAI 兼容端点（默认 https://api.deepseek.com）
  --api-key <key>   密钥（默认读环境变量 GAVEL_API_KEY 或 DEEPSEEK_API_KEY）
  --max-tokens <n>  透镜输出上限（默认 3000）
  --max-chars <n>   每个透镜的上下文上限字符（默认 24000）
  --max-findings <n> 每个透镜最多报告数（默认 12）

环境变量：GAVEL_API_KEY、GAVEL_BASE_URL、GAVEL_MODEL、GAVEL_MAX_TOKENS。
`;
}

function fail(message: string): never {
  console.error(`gavel: ${message}`);
  process.exit(1);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** 解析命令行参数（简化实现，支持 --k v 与重复旗标）。 */
function parseArgs(argv: string[]): { command: string; options: CliOptions } {
  const options: CliOptions = {
    paths: [],
    deep: false,
    emitRules: false,
    history: true,
    historyDir: join(process.cwd(), '.gavel'),
    model: process.env.GAVEL_MODEL ?? DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    baseUrl: process.env.GAVEL_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.GAVEL_API_KEY ?? process.env.DEEPSEEK_API_KEY,
    maxTokens: validPositiveInt(process.env.GAVEL_MAX_TOKENS),
    quiet: false,
  };
  const extra = options as CliOptions & Record<string, unknown>;

  let command = 'review';
  const flags: string[] = [];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
      console.log(ENGINE_VERSION);
      process.exit(0);
    }
    // 仅当子命令词出现在首位时才切换命令，避免吞掉旗标值或游离参数
    if (command === 'review' && argv[0] === arg && (arg === 'review' || arg === 'history' || arg === 'rules')) {
      command = arg;
      continue;
    }
    flags.push(arg);
  }

  // 取值旗标：--k v（v 不得以 -- 开头）；默认不可重复，repeatable 例外
  const take = (name: string, repeatable = false): string | undefined => {
    const index = flags.indexOf(`--${name}`);
    if (index === -1) return undefined;
    if (!repeatable && flags.indexOf(`--${name}`, index + 1) !== -1) {
      fail(`参数 --${name} 重复指定`);
    }
    const value = flags[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`参数 --${name} 缺少值`);
    flags.splice(index, 2);
    return value;
  };
  // 布尔旗标（重复指定视为同义）
  const flag = (name: string): boolean => {
    const index = flags.indexOf(`--${name}`);
    if (index === -1) return false;
    flags.splice(index, 1);
    return true;
  };

  if (command === 'history') {
    const historyDir = take('history-dir');
    if (historyDir != null) options.historyDir = historyDir;
    extra.stats = flag('stats');
    const last = take('last');
    if (last != null) extra.last = parsePositiveInt(last, '--last');
    if (!extra.stats && last == null) fail('history 子命令需要 --last <n> 或 --stats');
    rejectLeftovers(flags);
    return { command, options };
  }

  if (command === 'rules') {
    const historyDir = take('history-dir');
    if (historyDir != null) options.historyDir = historyDir;
    const rules = take('rules');
    if (rules != null) options.rulesFile = rules;
    extra.list = flag('list');
    const add = take('add');
    if (add != null) {
      const file = flags.shift();
      if (!file || file.startsWith('--')) fail('rules --add 需要 <key> <file>');
      extra.addKey = add;
      extra.addFile = file;
      rejectLeftovers(flags);
      return { command, options };
    }
    const drop = take('drop');
    if (drop != null) {
      extra.dropId = drop;
      rejectLeftovers(flags);
      return { command, options };
    }
    if (extra.list) {
      rejectLeftovers(flags);
      return { command, options };
    }
    fail('rules 子命令需要 --list、--add <key> <file> 或 --drop <id>');
  }

  // review
  const diff = take('diff');
  if (diff != null) options.diff = diff;
  while (true) {
    const path = take('path', true);
    if (path == null) break;
    options.paths.push(path);
  }
  const base = take('base');
  if (base != null) options.base = base;
  // 范围互斥校验
  const scopeSources = [base != null, diff != null, options.paths.length > 0].filter(Boolean).length;
  if (scopeSources > 1) fail('--base、--diff、--path 互斥，只能指定其一');
  const lens = take('lens');
  if (lens != null) {
    const ids = lens.split(',').map((l) => l.trim()).filter(Boolean);
    if (ids.length === 0) fail('--lens 至少需要一个透镜 id（correctness/security/maintainability）');
    options.lenses = ids;
  }
  options.deep = flag('deep');
  options.emitRules = flag('emit-rules');
  if (flag('no-history')) options.history = false;
  const historyDir = take('history-dir');
  if (historyDir != null) options.historyDir = historyDir;
  const rules = take('rules');
  if (rules != null) options.rulesFile = rules;
  const out = take('out');
  if (out != null) options.out = out;
  const jsonOut = take('json-out');
  if (jsonOut != null) options.jsonOut = jsonOut;
  const failOn = take('fail-on');
  if (failOn != null) {
    const valid: SeverityLevel[] = ['blocker', 'required', 'recommended', 'optional', 'informational'];
    if (!valid.includes(failOn as SeverityLevel)) fail(`--fail-on 取值无效：${failOn}`);
    options.failOn = failOn as SeverityLevel;
  }
  options.quiet = flag('quiet');
  const model = take('model');
  if (model != null) options.model = model;
  const provider = take('provider');
  if (provider != null) options.provider = provider;
  const baseUrl = take('base-url');
  if (baseUrl != null) options.baseUrl = baseUrl;
  const apiKey = take('api-key');
  if (apiKey != null) options.apiKey = apiKey;
  const maxTokens = take('max-tokens');
  if (maxTokens != null) options.maxTokens = parsePositiveInt(maxTokens, '--max-tokens');
  const maxChars = take('max-chars');
  if (maxChars != null) options.maxChars = parsePositiveInt(maxChars, '--max-chars');
  const maxFindings = take('max-findings');
  if (maxFindings != null) options.maxFindings = parsePositiveInt(maxFindings, '--max-findings');

  // 剩余未知旗标与游离参数
  rejectLeftovers(flags);

  return { command, options };
}

/** 解析正整数参数；非法值直接报错。 */
function parsePositiveInt(raw: string, name: string): number | undefined {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} 需要正整数，收到：${raw}`);
  return value;
}

/** 环境变量中的正整数；非法值返回 undefined（环境变量静默忽略）。 */
function validPositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 剩余旗标与游离参数一律报错。 */
function rejectLeftovers(flags: string[]): void {
  const leftover = flags.find((f) => f.startsWith('--'));
  if (leftover) fail(`未知参数 ${leftover}（--help 查看用法）`);
  const stray = flags.find((f) => !f.startsWith('--'));
  if (stray) fail(`未知参数 ${stray}（--help 查看用法）`);
}

async function cmdReview(options: CliOptions): Promise<number> {
  if (!options.apiKey) {
    fail('缺少 API 密钥：请设置 GAVEL_API_KEY 或使用 --api-key');
  }
  // 解析审查范围
  let scope;
  if (options.base != null) {
    const diffText = execFileSync('git', ['diff', '--unified=8', options.base, '--'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    scope = { kind: 'diff' as const, diffText };
  } else if (options.diff != null) {
    if (options.diff === '-' && process.stdin.isTTY) {
      fail('--diff - 需要从 stdin 读取 diff（请通过管道输入），当前终端没有输入流');
    }
    const text = options.diff === '-' ? readStdin() : readFileSync(options.diff, 'utf8');
    scope = { kind: 'diff' as const, diffText: text };
  } else if (options.paths.length > 0) {
    scope = { kind: 'paths' as const, paths: options.paths };
  } else {
    fail('需要指定审查范围：--diff、--path 或 --base 之一');
  }

  const rulesFile = options.rulesFile ?? join(options.historyDir, 'rules.json');
  const rules = loadRules(rulesFile);
  const history = options.history
    ? new JsonlDocket(options.historyDir)
    : undefined;

  const llm = createHttpClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
  });

  const report: ReviewReport = await runReview(
    {
      scope,
      lenses: options.lenses, // 原样传递，由引擎校验未知透镜 id
      deep: options.deep,
      model: { provider: options.provider, model: options.model },
      maxTokens: options.maxTokens,
      maxCharsPerLens: options.maxChars,
      maxFindingsPerLens: options.maxFindings,
      rules,
      rulesFile,
      history,
      generatedRules: undefined,
    },
    { llm },
  );

  // 生成抑制规则（可选；写入失败仅告警，不阻断本次审查）
  if (options.emitRules) {
    const existing = loadRules(rulesFile);
    const fresh = generateRules(report.findings.concat(report.suppressed.map((s) => s.finding)), 'required', existing);
    if (fresh.length > 0) {
      try {
        saveRules(rulesFile, existing.concat(fresh));
        report.generatedRules = fresh;
        report.rulesFile = rulesFile;
      } catch (error) {
        console.warn(`gavel: 抑制规则写入失败（不影响本次审查）: ${(error as Error).message}`);
      }
    }
  }

  const markdown = renderMarkdown(report);
  if (options.out) {
    writeFileSync(options.out, markdown, 'utf8');
  } else if (!options.quiet) {
    console.log(markdown);
  } else {
    const counts = report.stats.bySeverity;
    console.log(
      `gavel: ${report.stats.mergedFindings} 个问题` +
        Object.entries(counts)
          .map(([level, count]) => ` ${level}=${count}`)
          .join('') +
        `（耗时 ${report.durationMs}ms）`,
    );
  }
  if (options.jsonOut) writeFileSync(options.jsonOut, JSON.stringify(report, null, 2), 'utf8');

  if (options.failOn) {
    const threshold = severityRank(options.failOn);
    const gate = report.findings.some((f) => severityRank(f.severity) >= threshold);
    return gate ? 2 : 0;
  }
  return 0;
}

async function cmdHistory(
  options: CliOptions & { last?: number; stats?: boolean },
): Promise<number> {
  const docket = new JsonlDocket(options.historyDir);
  if (options.stats) {
    const entries = await docket.recent(500);
    const stats = summarize(entries);
    console.log(`案卷：${join(options.historyDir, 'docket.jsonl')}`);
    console.log(`运行次数：${stats.runs}`);
    console.log(`时间范围：${stats.firstTs ?? '-'} → ${stats.lastTs ?? '-'}`);
    console.log(`累计发现：${stats.totalFindings}`);
    if (Object.keys(stats.bySeverity).length > 0) {
      console.log('级别分布：');
      for (const [level, count] of Object.entries(stats.bySeverity)) {
        console.log(`  ${level}: ${count}`);
      }
    }
    if (stats.topFiles.length > 0) {
      console.log('问题高发文件：');
      for (const item of stats.topFiles) console.log(`  ${item.file}: ${item.count}`);
    }
    return 0;
  }
  const entries = await docket.recent(options.last ?? 5);
  if (entries.length === 0) {
    console.log('案卷为空。');
    return 0;
  }
  for (const entry of entries) {
    const files = entry.scope.files.join(', ').slice(0, 80);
    console.log(
      `${entry.ts}  ${entry.id}  发现 ${entry.counts.findings} 个（抑制 ${entry.counts.suppressed}）  ${files}`,
    );
  }
  return 0;
}

async function cmdRules(options: CliOptions & { addKey?: string; addFile?: string; dropId?: string }): Promise<number> {
  const rulesFile = options.rulesFile ?? join(options.historyDir, 'rules.json');
  const rules = loadRules(rulesFile);
  if (options.addKey != null) {
    if (options.addFile == null) {
      console.error('gavel: rules --add 需要 <key> <file>');
      return 1;
    }
    const rule: SuppressionRule = {
      id: `r-${String(maxRuleSeq(rules) + 1).padStart(3, '0')}`,
      file: options.addFile,
      source: 'any',
      key: options.addKey,
      reason: '手动添加',
      createdAt: new Date().toISOString(),
    };
    saveRules(rulesFile, rules.concat(rule));
    console.log(`已添加规则 ${rule.id}：${rule.file} 关键词「${rule.key}」`);
    return 0;
  }
  if (options.dropId != null) {
    const next = rules.filter((r) => r.id !== options.dropId);
    if (next.length === rules.length) {
      console.error(`未找到规则 ${options.dropId}`);
      return 1;
    }
    saveRules(rulesFile, next);
    console.log(`已删除规则 ${options.dropId}`);
    return 0;
  }
  if (rules.length === 0) {
    console.log(`规则文件 ${rulesFile} 为空或不存在。`);
    return 0;
  }
  for (const rule of rules) {
    console.log(`${rule.id}  ${rule.file}  「${rule.key}」  ${rule.source}  ${rule.reason}`);
  }
  return 0;
}

/** CLI 主入口。 */
export async function main(argv: string[]): Promise<number> {
  const { command, options } = parseArgs(argv);
  const extra = options as CliOptions & {
    last?: number;
    stats?: boolean;
    addKey?: string;
    addFile?: string;
    dropId?: string;
  };
  try {
    if (command === 'review') return await cmdReview(options);
    if (command === 'history') return await cmdHistory(extra);
    return await cmdRules(extra);
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error('gavel: 审查已取消');
      return 130;
    }
    fail(message);
  }
}
