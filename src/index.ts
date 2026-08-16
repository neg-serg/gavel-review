/**
 * gavel-review 公共入口。
 *
 * 两个用途：
 * 1. 库 API：引擎、透镜、哨兵、合并、抑制、案卷、报告等（独立 CLI 亦由此构成）；
 * 2. dsh 插件模块：具名导出 name/inject/Config/apply，供 Cordis loader 装载
 *    （load 时 `exports.default ?? exports`，本模块无 default，loader 直接使用命名空间）。
 *
 * 注意：dsh 适配器（src/dsh/plugin.ts）引用了 dsh 生态包，
 * 仅在 dsh 环境加载；独立 CLI 通过子路径引用，不触碰该模块。
 */

// 领域模型
export type * from './core/types.ts';

// 引擎
export { ENGINE_VERSION, DEFAULTS, runReview } from './core/engine.ts';
export type { RunDeps } from './core/engine.ts';

// 透镜
export { LENS_REGISTRY, listLenses, getLens, resolveLenses } from './core/lenses.ts';
export type { LensDef, ChecklistItem } from './core/lenses.ts';

// 静态哨兵
export { TRIPWIRE_RULES, scanTripwire } from './core/tripwire.ts';
export type { TripwireRule, TripwirePattern } from './core/tripwire.ts';

// diff 解析
export { parseDiff, normalizePath } from './core/diff.ts';
export type { ParsedDiff, ParsedFile, Hunk, HunkLine } from './core/diff.ts';

// 合并与定级
export {
  mergeCandidates,
  clusterCandidates,
  fingerprintOf,
  significantTokens,
  tokenOverlap,
  sortFindings,
} from './core/merge.ts';
export type { Candidate } from './core/merge.ts';
export {
  computeScore,
  levelForScore,
  severityRank,
  severityLabel,
  severityBadge,
} from './core/severity.ts';

// 抑制规则
export {
  globToRegExp,
  ruleMatches,
  loadRules,
  saveRules,
  generateRules,
  applyRules,
} from './core/suppress.ts';

// 案卷（历史）
export { JsonlDocket, summarize } from './core/docket.ts';
export type { DocketStats } from './core/docket.ts';

// 报告
export { renderMarkdown, toJson } from './core/report.ts';

// 模型客户端
export { createHttpClient } from './llm/http.ts';
export type { HttpClientConfig } from './llm/http.ts';

// CLI 入口（bin/gavel.mjs 调用）
export { main as cliMain } from './cli.ts';

// —— dsh 插件模块（与 dsh 工具插件同一约定）——
export { name, inject, Config, apply } from './dsh/plugin.ts';
export type { GavelConfig } from './dsh/plugin.ts';
