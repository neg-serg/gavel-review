/**
 * 抑制规则引擎：
 * - 加载/保存规则文件（JSON，`.gavel/rules.json` 或自定义路径）；
 * - 匹配规则（文件 glob + 来源 + 标题关键词）过滤发现；
 * - 从确认的问题自动生成候选规则，防止同类问题反复上报。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FindingSource, MergedFinding, SeverityLevel, SuppressionFile, SuppressionRule } from './types.ts';
import { normalizePath } from './diff.ts';
import { severityRank } from './severity.ts';
import { significantTokens } from './merge.ts';

/** glob 模式 → 正则。支持 `**`（任意字符含斜杠）、`*`（段内任意）、`?`（单字符）。 */
export function globToRegExp(glob: string): RegExp {
  const norm = normalizePath(glob);
  let pattern = '';
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i]!;
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        i += 2;
        if (norm[i] === '/') {
          i++; // `**/`：零或多层目录
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*'; // 裸 `**`
        }
      } else {
        i++;
        pattern += '[^/]*';
      }
    } else if (ch === '?') {
      i++;
      pattern += '[^/]';
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** 判断规则是否命中某个发现（mixed 来源同时可被 lens 与 tripwire 规则命中）。 */
export function ruleMatches(rule: SuppressionRule, finding: MergedFinding): boolean {
  if (rule.source !== 'any') {
    const matches = (source: FindingSource): boolean =>
      source === rule.source || source === 'mixed';
    if (!matches(finding.source)) return false;
  }
  // 无文件定位的发现只受“全局”规则约束（如 **），避免文件作用域规则越权抑制
  const file = finding.file ? normalizePath(finding.file) : '';
  const glob = globToRegExp(rule.file);
  if (file ? !glob.test(file) : !glob.test('')) return false;
  if (!rule.key) return false;
  return finding.title.toLowerCase().includes(rule.key.toLowerCase());
}

/** 从文件中加载规则；文件不存在返回空列表。 */
export function loadRules(path: string): SuppressionRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SuppressionFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(
      (r): r is SuppressionRule =>
        r != null &&
        typeof r.id === 'string' &&
        typeof r.file === 'string' &&
        typeof r.key === 'string' &&
        typeof r.reason === 'string' &&
        typeof r.createdAt === 'string' &&
        (r.source === 'lens' || r.source === 'tripwire' || r.source === 'any'),
    );
  } catch {
    return [];
  }
}

/** 保存规则文件（自动创建目录）。 */
export function saveRules(path: string, rules: SuppressionRule[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: SuppressionFile = { version: 1, rules };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * 从发现生成抑制规则。
 * @param findings - 已确认的发现（通常为本次报告中达到门槛级别的）。
 * @param minLevel - 生成门槛级别（含）。
 * @param existing - 已有规则（避免重复生成）。
 */
export function generateRules(
  findings: MergedFinding[],
  minLevel: SeverityLevel = 'required',
  existing: SuppressionRule[] = [],
): SuppressionRule[] {
  const threshold = severityRank(minLevel);
  const seen = new Set(existing.map((r) => `${normalizePath(r.file)}|${r.key}`));
  const rules: SuppressionRule[] = [];
  let seq = maxRuleSeq(existing) + 1;
  for (const finding of findings) {
    if (severityRank(finding.severity) < threshold) continue;
    const file = finding.file ?? '**';
    // 关键词：含 CJK 时用完整标题前缀（子串匹配对中文更可靠），否则用前 3 个词元
    const hasCjk = /[\u4e00-\u9fff]/.test(finding.title);
    const key = hasCjk
      ? finding.title.slice(0, 24)
      : significantTokens(finding.title).slice(0, 3).join(' ');
    if (!key) continue;
    const dedupe = `${normalizePath(file)}|${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rules.push({
      id: `r-${String(seq++).padStart(3, '0')}`,
      file,
      // mixed 来源同时含哨兵与透镜证据，规则放宽为 any 以保证可复现抑制
      source: finding.source === 'lens' ? 'lens' : finding.source === 'tripwire' ? 'tripwire' : 'any',
      key,
      reason: `自动生成：${finding.title}`,
      createdAt: new Date().toISOString(),
    });
  }
  return rules;
}

/** 取规则集合中最大的数字后缀（r-001 → 1），无规则返回 0。 */
export function maxRuleSeq(rules: SuppressionRule[]): number {
  let max = 0;
  for (const rule of rules) {
    const match = /^r-(\d+)$/.exec(rule.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * 应用规则：过滤发现，返回 { 保留列表, 被抑制列表 }。
 */
export function applyRules(
  findings: MergedFinding[],
  rules: SuppressionRule[],
): { kept: MergedFinding[]; suppressed: Array<{ finding: MergedFinding; ruleId: string }> } {
  if (rules.length === 0) return { kept: findings, suppressed: [] };
  const kept: MergedFinding[] = [];
  const suppressed: Array<{ finding: MergedFinding; ruleId: string }> = [];
  for (const finding of findings) {
    const rule = rules.find((r) => ruleMatches(r, finding));
    if (rule) suppressed.push({ finding, ruleId: rule.id });
    else kept.push(finding);
  }
  return { kept, suppressed };
}
