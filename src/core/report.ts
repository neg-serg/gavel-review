/**
 * 报告渲染：同一份 ReviewReport 输出两种形态——
 * - Markdown 人类可读报告（CLI 与 dsh 工具展示均用）；
 * - 工具返回的 JSON 值（即报告本身，保证结构可序列化）。
 */

import type { ReviewReport } from './types.ts';
import { severityBadge, severityLabel, severityRank } from './severity.ts';

/** 每个级别的 Markdown 小节标题。 */
const LEVEL_TITLES = {
  blocker: '阻断发布（Blocking）',
  required: '必须修复（Required）',
  recommended: '建议修复（Recommended）',
  optional: '可选优化（Optional）',
  informational: '观察（Informational）',
} as const;

/** 渲染 Markdown 报告。 */
export function renderMarkdown(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push('# 对抗式代码审查报告', '');
  lines.push(`- 运行 id：\`${report.id}\``);
  lines.push(`- 时间：${report.startedAt}（耗时 ${report.durationMs}ms）`);
  lines.push(`- 引擎版本：${report.engineVersion}`);
  lines.push(`- 模型：${report.model.provider} / ${report.model.model}`);
  lines.push(
    `- 范围：${report.scope.kind === 'diff' ? 'diff' : '文件'}（${report.scope.files.length} 个文件）`,
  );
  lines.push(`- 透镜：${report.lenses.map((l) => lensLabel(l)).join('、')}${report.deep ? '（含深度复核）' : ''}`);
  lines.push('');

  const total = report.stats.mergedFindings;
  const summary = ['blocker', 'required', 'recommended', 'optional', 'informational']
    .filter((level) => (report.stats.bySeverity[level as keyof typeof report.stats.bySeverity] ?? 0) > 0)
    .map(
      (level) =>
        `${severityLabel(level as keyof typeof LEVEL_TITLES)} ${report.stats.bySeverity[level as keyof typeof report.stats.bySeverity]}`,
    );
  lines.push(`## 结论`, '');
  lines.push(
    total === 0
      ? '未发现值得报告的问题。'
      : `共发现 **${total}** 个问题：${summary.join(' / ')}。`,
    '',
  );

  if (report.skipped.length > 0) {
    lines.push('> 注意：以下文件未能读取，未纳入审查：');
    for (const item of report.skipped) lines.push(`> - ${item.path}（${item.reason}）`);
    lines.push('');
  }

  // 按级别分组输出
  const byLevel: Record<string, ReviewReport['findings']> = {};
  for (const finding of report.findings) {
    const list = byLevel[finding.severity] ?? [];
    list.push(finding);
    byLevel[finding.severity] = list;
  }
  const levels = (Object.keys(byLevel) as Array<keyof typeof LEVEL_TITLES>).sort(
    (a, b) => severityRank(b) - severityRank(a),
  );

  if (levels.length === 0) {
    lines.push('## 发现详情', '');
    lines.push('（无）', '');
  }
  for (const level of levels) {
    const findings = byLevel[level]!;
    lines.push(`## ${LEVEL_TITLES[level]}（${findings.length}）`, '');
    findings.forEach((finding, index) => {
      const location = finding.file
        ? `\`${finding.file}${finding.line != null ? `:${finding.line}` : ''}\``
        : '（位置未知）';
      lines.push(`### ${index + 1}. ${finding.title}`, '');
      lines.push(`- 位置：${location}`);
      lines.push(
        `- 级别：${severityBadge(finding.severity)}（${finding.score}/10，影响 ${finding.impact}，置信 ${finding.confidence}）`,
      );
      if (finding.lenses.length > 0) {
        lines.push(`- 视角：${finding.lenses.map((l) => lensLabel(l)).join('、')}`);
      }
      if (finding.source !== 'lens') {
        lines.push(`- 来源：${finding.source === 'tripwire' ? '静态哨兵' : '哨兵 + 透镜'}${finding.ruleId ? `（规则 ${finding.ruleId}）` : ''}`);
      }
      if (finding.checkpoint) lines.push(`- 检查点：${finding.checkpoint}`);
      if (finding.known) lines.push('- 状态：与历史记录中的已知问题指纹一致');
      if (finding.verified === 'confirmed') lines.push('- 深度复核：已确认');
      if (finding.verified === 'refuted') lines.push('- 深度复核：被驳回（降级为观察）');
      lines.push('');
      lines.push(finding.detail, '');
      if (finding.evidence.length > 0) {
        lines.push('**证据**：');
        for (const evidence of finding.evidence) {
          // 转义反引号并压平换行，保证 Markdown 行内代码块不被破坏
          const flat = evidence.replace(/`/g, '\\`').replace(/\n/g, ' ').slice(0, 240);
          lines.push(`- \`${flat}\``);
        }
        lines.push('');
      }
      if (finding.suggestion) {
        lines.push('**修复建议**：');
        lines.push(finding.suggestion, '');
      }
    });
  }

  if (report.suppressed.length > 0) {
    lines.push(`## 被抑制的发现（${report.suppressed.length}）`, '');
    for (const item of report.suppressed) {
      lines.push(
        `- \`${item.finding.file ?? '?'}\` ${item.finding.title}（命中规则 ${item.ruleId}）`,
      );
    }
    lines.push('');
  }

  if (report.history && report.history.runs > 0) {
    lines.push(
      `## 历史对照`,
      '',
      `- 案卷中已有 ${report.history.runs} 次审查；本次 ${report.history.known} 个问题与历史指纹一致。`,
      '',
    );
  }

  if (report.generatedRules && report.generatedRules.length > 0) {
    lines.push(
      `## 生成的抑制规则（${report.generatedRules.length}）`,
      '',
      `已写入 \`${report.rulesFile ?? 'rules.json'}\`，后续审查将自动抑制同类问题。`,
      '',
    );
    for (const rule of report.generatedRules) {
      lines.push(`- \`${rule.id}\` \`${rule.file}\` 关键词「${rule.key}」（${rule.source}）`);
    }
    lines.push('');
  }

  if (report.parseFailures.length > 0) {
    lines.push(`## 解析失败警告（${report.parseFailures.length}）`, '');
    for (const failure of report.parseFailures) {
      lines.push(`- ${failure.lens}: ${failure.reason}`);
    }
    lines.push('');
  }

  lines.push('---', '', `*由 gavel-review 生成：只报告问题，不修改代码。*`, '');
  return lines.join('\n');
}

function lensLabel(id: string): string {
  const labels: Record<string, string> = {
    correctness: '正确性',
    security: '安全性',
    maintainability: '可维护性',
  };
  return labels[id] ?? id;
}

/**
 * 校验报告可安全序列化（无 undefined/函数/循环引用），返回 JSON 字符串。
 */
export function toJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}
