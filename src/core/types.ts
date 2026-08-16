/**
 * 领域模型：审查目标、发现、报告与配置的全部类型定义。
 *
 * 本模块不依赖任何外部包，可被核心引擎、CLI 与 dsh 适配器共同引用。
 */

/** 内置审查透镜（视角）标识。 */
export type LensId = 'correctness' | 'security' | 'maintainability';

/** 全部内置透镜标识的稳定列表。 */
export const LENS_IDS: readonly LensId[] = ['correctness', 'security', 'maintainability'];

/** 严重度分级：从阻断发布到纯观察，按可操作性命名。 */
export type SeverityLevel = 'blocker' | 'required' | 'recommended' | 'optional' | 'informational';

/** 分级序列，用于排序（index 越大越严重）。 */
export const SEVERITY_ORDER: readonly SeverityLevel[] = [
  'informational',
  'optional',
  'recommended',
  'required',
  'blocker',
];

/** 发现来源。 */
export type FindingSource = 'lens' | 'tripwire' | 'mixed';

/** 一个透镜返回的原始发现（模型输出，已归一化）。 */
export type LensFinding = {
  /** 产生该发现的透镜。 */
  lens: LensId;
  /** 命中该透镜审查清单中的哪个检查点（可落地追踪）。 */
  checkpoint: string;
  /** 一句话标题。 */
  title: string;
  /** 相关文件路径；无法定位时为 null。 */
  file: string | null;
  /** 相关行号（1 起）；无法定位时为 null。 */
  line: number | null;
  /** 问题描述。 */
  detail: string;
  /** 支撑证据（代码片段/调用链/复现路径）。 */
  evidence: string;
  /** 修复建议。 */
  suggestion: string;
  /** 影响程度 0-3：0 无影响 / 1 轻微 / 2 显著 / 3 致命。 */
  impact: 0 | 1 | 2 | 3;
  /** 置信度 0-3：0 猜测 / 1 存疑 / 2 较有把握 / 3 确凿。 */
  confidence: 0 | 1 | 2 | 3;
};

/** 确定性静态哨兵规则的命中结果。 */
export type TripwireHit = {
  /** 规则 id。 */
  ruleId: string;
  /** 规则名称。 */
  ruleName: string;
  /** 规则分类。 */
  category: string;
  /** 命中文件。 */
  file: string;
  /** 命中行号（1 起）。 */
  line: number;
  /** 命中片段（截断）。 */
  snippet: string;
  /** 规则内置的影响程度。 */
  impact: 0 | 1 | 2 | 3;
  /** 规则内置的置信度。 */
  confidence: 0 | 1 | 2 | 3;
  /** 规则内置的修复建议。 */
  suggestion: string;
};

/** 合并后的最终发现（仲裁产物）。 */
export type MergedFinding = {
  /** 稳定指纹，用于跨次审查去重与历史对照。 */
  fingerprint: string;
  /** 严重度级别。 */
  severity: SeverityLevel;
  /** 确定性的严重度分值（0-10）。 */
  score: number;
  /** 影响程度（取簇内最高）。 */
  impact: 0 | 1 | 2 | 3;
  /** 置信度（取簇内最高）。 */
  confidence: 0 | 1 | 2 | 3;
  /** 来源。 */
  source: FindingSource;
  /** 产生该发现的透镜集合（跨透镜佐证）。 */
  lenses: LensId[];
  /** 命中检查点（取簇内首个携带检查点的成员）。 */
  checkpoint: string;
  /** 标题（取簇内分值最高的成员，同分时透镜优先）。 */
  title: string;
  /** 文件。 */
  file: string | null;
  /** 行号锚点（取簇内最小行号，即最先报告的位置）。 */
  line: number | null;
  /** 描述（合并簇内成员，去重）。 */
  detail: string;
  /** 证据（合并簇内成员）。 */
  evidence: string[];
  /** 修复建议（取首个非空）。 */
  suggestion: string;
  /** 静态哨兵规则 id（来源为 tripwire 时非空）。 */
  ruleId?: string;
  /** 深度复核结论：confirmed（确认）| refuted（驳回）| 未复核时为 undefined。 */
  verified?: 'confirmed' | 'refuted';
  /** 与历史记录中的已知问题指纹一致。 */
  known: boolean;
};

/** 被抑制规则过滤掉的发现。 */
export type SuppressedFinding = {
  finding: MergedFinding;
  /** 命中的抑制规则。 */
  ruleId: string;
};

/** 透镜调用失败等解析问题记录。 */
export type ParseFailure = {
  /** 失败来源（透镜 id 或 'deep'）。 */
  lens: LensId | 'deep' | 'tripwire';
  /** 失败原因。 */
  reason: string;
  /** 原始输出（截断）。 */
  raw: string;
};

/** 审查范围：统一 diff 文本，或一组文件路径。 */
export type ReviewScope =
  | { kind: 'diff'; diffText: string }
  | { kind: 'paths'; paths: string[] };

/** 模型路由说明。 */
export type ModelSpec = {
  provider: string;
  model: string;
};

/** 审查运行选项。 */
export interface ReviewOptions {
  scope: ReviewScope;
  /** 启用的透镜 id（原样传入，未知 id 由引擎校验并报错）；缺省为全部。 */
  lenses?: string[];
  /** 是否执行串行深度复核（挑战式再验证）。 */
  deep?: boolean;
  /** 模型路由。 */
  model: ModelSpec;
  /** 模型调用上限（输出 token）。 */
  maxTokens?: number;
  /** 每个透镜获得的上下文字符上限。 */
  maxCharsPerLens?: number;
  /** 每个透镜最多要求的发现条数。 */
  maxFindingsPerLens?: number;
  /** 已加载的抑制规则。 */
  rules?: SuppressionRule[];
  /** 抑制规则文件路径（写入报告以便追踪）。 */
  rulesFile?: string;
  /** 本次生成的抑制规则（写入报告以便追踪）。 */
  generatedRules?: SuppressionRule[];
  /** 历史记录存储（可选）。 */
  history?: HistoryStore;
  /** 取消信号。 */
  signal?: AbortSignal;
}

/** 审查统计。 */
export type ReviewStats = {
  files: number;
  hunks: number;
  addedLines: number;
  removedLines: number;
  tripwireHits: number;
  lensFindings: number;
  mergedFindings: number;
  suppressed: number;
  parseFailures: number;
  known: number;
  /** 按级别计数的发现分布。 */
  bySeverity: Partial<Record<SeverityLevel, number>>;
};

/**
 * 一次审查的完整报告（工具返回值与 JSON 报告的同一结构）。
 * 注意：使用 type 别名而非 interface，以便直接满足 dsh 工具输出
 * JsonValue 的可赋值性约束。
 */
export type ReviewReport = {
  /** 审查运行 id。 */
  id: string;
  /** 开始时间（ISO 8601）。 */
  startedAt: string;
  /** 耗时（毫秒）。 */
  durationMs: number;
  /** 引擎版本。 */
  engineVersion: string;
  /** 审查范围摘要。 */
  scope: {
    kind: 'diff' | 'paths';
    files: string[];
  };
  /** 无法读取/解析而被跳过的文件。 */
  skipped: Array<{ path: string; reason: string }>;
  /** 启用的透镜。 */
  lenses: LensId[];
  /** 是否执行了深度复核。 */
  deep: boolean;
  /** 模型路由。 */
  model: ModelSpec;
  stats: ReviewStats;
  findings: MergedFinding[];
  /** 被抑制的发现。 */
  suppressed: SuppressedFinding[];
  /** 透镜/复核失败记录。 */
  parseFailures: ParseFailure[];
  /** 历史对照摘要。 */
  history?: {
    /** 已知（与历史指纹重复）发现数。 */
    known: number;
    /** 历史记录条数。 */
    runs: number;
  };
  /** 抑制规则文件路径（若本次运行加载或生成了规则）。 */
  rulesFile?: string;
  /** 生成的抑制规则（当 emitRules 为真时）。 */
  generatedRules?: SuppressionRule[];
};

/** 抑制规则：让同类发现不再反复报告。 */
export type SuppressionRule = {
  /** 规则 id。 */
  id: string;
  /** 文件匹配模式（glob）。 */
  file: string;
  /** 来源过滤：lens | tripwire | any。 */
  source: 'lens' | 'tripwire' | 'any';
  /** 标题关键词（不区分大小写的子串匹配）。 */
  key: string;
  /** 创建原因。 */
  reason: string;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
};

/** 抑制规则文件格式。 */
export interface SuppressionFile {
  version: 1;
  rules: SuppressionRule[];
}

/** 历史记录中的单条审查摘要。 */
export interface DocketEntry {
  /** 审查运行 id。 */
  id: string;
  /** 开始时间（ISO 8601）。 */
  ts: string;
  /** 引擎版本。 */
  engineVersion: string;
  /** 审查范围。 */
  scope: ReviewReport['scope'];
  /** 计数。 */
  counts: {
    findings: number;
    suppressed: number;
    bySeverity: ReviewStats['bySeverity'];
  };
  /** 发现指纹列表（供增量审查对照）。 */
  fingerprints: Array<{
    fingerprint: string;
    severity: SeverityLevel;
    file: string | null;
    line: number | null;
    title: string;
  }>;
}

/** 历史记录存储接口（默认实现为 JSONL 文件）。 */
export interface HistoryStore {
  /** 追加一条审查摘要。 */
  append(entry: DocketEntry): Promise<void>;
  /** 读取最近 n 条。 */
  recent(n: number): Promise<DocketEntry[]>;
}

/** 模型调用客户端接口（引擎只依赖该接口，dsh 与 CLI 各自实现）。 */
export interface LlmClient {
  /** 一次非流式文本补全。 */
  complete(input: {
    system?: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}
