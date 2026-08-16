/**
 * 严重度定级：完全确定性的分值计算，不依赖模型主观判断。
 *
 * 分值 = 影响 × 2 + 置信度 + 佐证加成（多个独立视角同时命中 +1）。
 * 分级：9-10 blocker（阻断发布）/ 7-8 required（必须修复）/
 *       5-6 recommended（建议修复）/ 3-4 optional（可选优化）/ 0-2 informational（观察）。
 */

import type { SeverityLevel } from './types.ts';

/** 分值 → 级别。 */
export function levelForScore(score: number): SeverityLevel {
  if (score >= 9) return 'blocker';
  if (score >= 7) return 'required';
  if (score >= 5) return 'recommended';
  if (score >= 3) return 'optional';
  return 'informational';
}

/**
 * 计算严重度分值。
 * @param impact - 影响程度 0-3。
 * @param confidence - 置信度 0-3。
 * @param corroborated - 是否被多个独立来源佐证。
 */
export function computeScore(
  impact: number,
  confidence: number,
  corroborated: boolean,
): number {
  const clamped = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const base = clamped(impact, 0, 3) * 2 + clamped(confidence, 0, 3);
  return Math.min(10, base + (corroborated ? 1 : 0));
}

/** 级别排序权重（越大越严重），用于报告排序。 */
export function severityRank(level: SeverityLevel): number {
  switch (level) {
    case 'blocker':
      return 5;
    case 'required':
      return 4;
    case 'recommended':
      return 3;
    case 'optional':
      return 2;
    case 'informational':
      return 1;
  }
}

/** 报告用级别中文名。 */
export function severityLabel(level: SeverityLevel): string {
  switch (level) {
    case 'blocker':
      return '阻断发布';
    case 'required':
      return '必须修复';
    case 'recommended':
      return '建议修复';
    case 'optional':
      return '可选优化';
    case 'informational':
      return '观察';
  }
}

/** 报告用级别徽标（纯文本）。 */
export function severityBadge(level: SeverityLevel): string {
  switch (level) {
    case 'blocker':
      return 'BLOCKER';
    case 'required':
      return 'REQUIRED';
    case 'recommended':
      return 'RECOMMENDED';
    case 'optional':
      return 'OPTIONAL';
    case 'informational':
      return 'INFO';
  }
}
