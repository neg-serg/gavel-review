/**
 * 审查编排引擎：把一次审查组织成确定性流水线。
 *
 * 流水线：
 *  1. 摄取（collect）    —— 解析 diff 或读取文件，建立行映射
 *  2. 哨兵扫描（tripwire）—— 确定性规则先行
 *  3. 透镜探测（probe）   —— 各透镜并行调用模型（全部成功或部分失败都不中断）
 *  4. 深度复核（deep，可选）—— 对候选发现做串行挑战式再验证
 *  5. 仲裁合并（merge）   —— 跨透镜聚类、去重、定级、指纹
 *  6. 抑制过滤（suppress）—— 应用抑制规则
 *  7. 案卷记录（docket）  —— 追加历史、标记已知问题
 *
 * 引擎不绑定任何具体模型客户端，只依赖 LlmClient 接口。
 */

import { readFileSync } from 'node:fs';
import type {
  HistoryStore,
  LensFinding,
  LensId,
  LlmClient,
  MergedFinding,
  ParseFailure,
  ReviewOptions,
  ReviewReport,
  ReviewScope,
} from './types.ts';
import { LENS_REGISTRY, getLens, resolveLenses } from './lenses.ts';
import { scanTripwire } from './tripwire.ts';
import { parseDiff, normalizePath, type HunkLine } from './diff.ts';
import { mergeCandidates, type Candidate } from './merge.ts';
import { applyRules } from './suppress.ts';

/** 引擎版本。 */
export const ENGINE_VERSION = '0.1.0';

/** 默认配置。 */
export const DEFAULTS = {
  maxCharsPerLens: 24_000,
  maxFindingsPerLens: 12,
  maxTokens: 3_000,
  temperature: 0.2,
  deepTopK: 8,
} as const;

/** 运行依赖。 */
export interface RunDeps {
  llm: LlmClient;
}

/** 解析后的单文件视图。 */
interface ResolvedFile {
  path: string;
  /** 行映射：行号 → 文本（diff 模式为 ctx+add 行；paths 模式为全部行）。 */
  lines: Array<{ line: number; text: string }>;
  /** diff 模式下的 hunk 分组（含 del 行，用于透镜上下文）。 */
  hunks?: Array<Array<{ type: HunkLine['type']; line: number | null; text: string }>>;
}

/** 解析后的审查范围。 */
interface ResolvedScope {
  kind: ReviewScope['kind'];
  files: ResolvedFile[];
  skipped: ReviewReport['skipped'];
}

/**
 * 执行一次完整审查。
 */
export async function runReview(options: ReviewOptions, deps: RunDeps): Promise<ReviewReport> {
  const startedAt = new Date();
  const id = `${startedAt.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const signal = options.signal;
  throwIfAborted(signal);

  const lenses = resolveLenses(options.lenses);
  const invalidLenses = (options.lenses ?? []).filter((id) => !getLens(id));
  if (invalidLenses.length > 0) {
    throw new Error(
      `未知透镜 id：${invalidLenses.join(', ')}（可用：correctness / security / maintainability）`,
    );
  }
  const limits = {
    maxCharsPerLens: options.maxCharsPerLens ?? DEFAULTS.maxCharsPerLens,
    maxFindingsPerLens: options.maxFindingsPerLens ?? DEFAULTS.maxFindingsPerLens,
    maxTokens: options.maxTokens ?? DEFAULTS.maxTokens,
  };

  // 1. 摄取
  const scope = await collect(options.scope, signal);
  const candidates: Candidate[] = [];
  const parseFailures: ParseFailure[] = [];

  // 2. 哨兵扫描（确定性，无模型参与）
  const tripwireFiles = scope.files
    .filter((f) => f.lines.length > 0)
    .map((f) => ({ path: f.path, lines: f.lines }));
  const tripwireHits = scanTripwire(tripwireFiles);
  for (const hit of tripwireHits) {
    candidates.push({
      lens: 'tripwire',
      ruleId: hit.ruleId,
      ruleName: hit.ruleName,
      category: hit.category,
      file: hit.file,
      line: hit.line,
      snippet: hit.snippet,
      impact: hit.impact,
      confidence: hit.confidence,
      suggestion: hit.suggestion,
    });
  }

  // 3. 透镜探测：并行扇出，单透镜失败不拖垮整体
  if (scope.files.length > 0) {
    const context = buildLensContext(scope, limits.maxCharsPerLens);
    const validFiles = new Set(scope.files.map((f) => f.path));
    const probes = lenses.map((lens) =>
      probeLens(lens, context, validFiles, limits, deps.llm, signal),
    );
    const results = await Promise.allSettled(probes);
    // 取消优先：任何透镜因取消失败，立即中止整次审查（不写案卷、不产生半成品）
    if (signal?.aborted) throw new DOMException('审查已取消', 'AbortError');
    for (let i = 0; i < results.length; i++) {
      const lens = lenses[i]!;
      const result = results[i]!;
      if (result.status === 'fulfilled') {
        candidates.push(...result.value.findings);
        parseFailures.push(...result.value.failures);
      } else {
        parseFailures.push({
          lens,
          reason: `透镜调用失败：${(result.reason as Error).message}`,
          raw: '',
        });
      }
    }
  }

  // 4. 初步合并（供深度复核与最终输出共用）
  const knownFingerprints = options.history
    ? await loadKnownFingerprints(options.history)
    : new Set<string>();
  let findings = mergeCandidates(candidates, knownFingerprints);

  // 5. 深度复核（串行挑战式再验证；调用失败降级为解析失败，与透镜失败容忍一致）
  if (options.deep && findings.length > 0) {
    try {
      const verdict = await deepChallenge(findings.slice(0, DEFAULTS.deepTopK), deps.llm, signal);
      parseFailures.push(...verdict.failures);
      for (const [index, v] of verdict.decisions.entries()) {
        const finding = findings[index];
        if (!finding) continue;
        if (v === 'confirmed') finding.verified = 'confirmed';
        else if (v === 'refuted') {
          finding.verified = 'refuted';
          finding.severity = 'informational';
          finding.score = Math.min(finding.score, 2);
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('审查已取消', 'AbortError');
      parseFailures.push({
        lens: 'deep',
        reason: `深度复核调用失败：${(error as Error).message}`,
        raw: '',
      });
    }
  }

  // 6. 抑制过滤
  const rules = options.rules ?? [];
  const filtered = applyRules(findings, rules);
  findings = filtered.kept;

  // 7. 案卷记录（存储失败不阻断审查；取消优先，不写案卷）
  throwIfAborted(signal);
  const historyStats = await recordHistory(options.history, signal, {
    id,
    startedAt: startedAt.toISOString(),
    findings: findings.concat(filtered.suppressed.map((s) => s.finding)),
    suppressedCount: filtered.suppressed.length,
    scope,
  });

  throwIfAborted(signal);
  const durationMs = Date.now() - startedAt.getTime();
  // 注意：dsh 工具输出需通过 lossless-JSON 边界校验，任何值为 undefined 的属性
  // 都会导致工具调用失败 —— 可选字段必须条件性发射，不能带 undefined 占位。
  return {
    id,
    startedAt: startedAt.toISOString(),
    durationMs,
    engineVersion: ENGINE_VERSION,
    scope: { kind: scope.kind, files: scope.files.map((f) => f.path) },
    skipped: scope.skipped,
    lenses,
    deep: options.deep ?? false,
    model: options.model,
    stats: buildStats(scope, tripwireHits.length, candidates, findings, filtered, parseFailures),
    findings,
    suppressed: filtered.suppressed,
    parseFailures,
    ...(historyStats ? { history: historyStats } : {}),
    ...(options.rulesFile ? { rulesFile: options.rulesFile } : {}),
    ...(options.generatedRules && options.generatedRules.length > 0
      ? { generatedRules: options.generatedRules }
      : {}),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('审查已取消', 'AbortError');
}

/** 从案卷加载历史指纹集合（失败视为空集）。 */
async function loadKnownFingerprints(history: HistoryStore): Promise<Set<string>> {
  try {
    const entries = await history.recent(500);
    return new Set(entries.flatMap((e) => e.fingerprints.map((f) => f.fingerprint)));
  } catch {
    return new Set();
  }
}

/** 摄取：diff 解析或文件读取。 */
async function collect(scope: ReviewScope, signal?: AbortSignal): Promise<ResolvedScope> {
  if (scope.kind === 'diff') {
    const parsed = parseDiff(scope.diffText);
    const files: ResolvedFile[] = [];
    for (const file of parsed.files) {
      if (file.isDeleted) continue; // 纯删除文件不进审查视图
      const lines: Array<{ line: number; text: string }> = [];
      const hunks: ResolvedFile['hunks'] = [];
      for (const hunk of file.hunks) {
        const group: NonNullable<ResolvedFile['hunks']>[number] = [];
        for (const line of hunk.lines) {
          group.push({ type: line.type, line: line.newLine ?? line.oldLine, text: line.text });
          if (line.type !== 'del' && line.newLine != null) {
            lines.push({ line: line.newLine, text: line.text });
          }
        }
        hunks.push(group);
      }
      files.push({ path: normalizePath(file.path), lines, hunks });
    }
    return { kind: 'diff', files, skipped: [] };
  }

  // paths 模式：读取文件
  const files: ResolvedFile[] = [];
  const skipped: ReviewReport['skipped'] = [];
  for (const rawPath of scope.paths) {
    throwIfAborted(signal);
    const path = normalizePath(rawPath);
    try {
      const content = readFileSync(rawPath, 'utf8').replace(/\r\n/g, '\n');
      const lines = content.split('\n').map((text, index) => ({ line: index + 1, text }));
      if (lines.length > 0 && lines[lines.length - 1]!.text === '') lines.pop();
      files.push({ path, lines });
    } catch (error) {
      skipped.push({ path, reason: (error as Error).message });
    }
  }
  return { kind: 'paths', files, skipped };
}

/** 为透镜构建统一上下文（带行号，diff 模式含删除行）。 */
function buildLensContext(scope: ResolvedScope, maxChars: number): string {
  const parts: string[] = [];
  for (const file of scope.files) {
    if (file.hunks) {
      // diff 视图：按 hunk 顺序渲染全部行
      const lines: Array<{ line: number | null; marker: string; text: string }> = [];
      for (const group of file.hunks) {
        for (const hunkLine of group) {
          const marker = hunkLine.type === 'add' ? '+' : hunkLine.type === 'del' ? '-' : ' ';
          lines.push({ line: hunkLine.line, marker, text: hunkLine.text });
        }
      }
      parts.push(renderLines(file.path, lines));
    } else {
      parts.push(
        renderLines(
          file.path,
          file.lines.map((l) => ({ line: l.line, marker: ' ', text: l.text })),
        ),
      );
    }
  }
  let context = parts.join('\n');
  if (context.length > maxChars) {
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = maxChars - headLen;
    context =
      context.slice(0, headLen) +
      `\n…（上下文已截断，省略 ${context.length - headLen - tailLen} 字符）…\n` +
      context.slice(-tailLen);
  }
  return context;
}

function renderLines(
  path: string,
  lines: Array<{ line: number | null; marker: string; text: string }>,
): string {
  const header = `### ${path}`;
  const width = Math.max(
    4,
    ...lines.map((l) => (l.line == null ? 4 : String(l.line).length)),
  );
  const body = lines
    .map((l) => {
      const no = l.line == null ? ''.padStart(width) : String(l.line).padStart(width);
      return `${no} |${l.marker} ${l.text}`;
    })
    .join('\n');
  return `${header}\n${body}`;
}

/** 单透镜探测：构造提示词 → 调用模型 → 解析并归一化发现。 */
async function probeLens(
  lens: LensId,
  context: string,
  validFiles: ReadonlySet<string>,
  limits: { maxCharsPerLens: number; maxFindingsPerLens: number; maxTokens: number },
  llm: LlmClient,
  signal: AbortSignal | undefined,
): Promise<{ findings: LensFinding[]; failures: ParseFailure[] }> {
  const def = LENS_REGISTRY[lens];
  const failures: ParseFailure[] = [];
  const checklist = def.checklist
    .map((item) => `- ${item.id} ${item.text}`)
    .join('\n');
  const fileList = [...validFiles].join(', ');
  const system =
    `${def.motto}\n` +
    `你是代码审查透镜「${def.label} · ${def.codename}」，只以「${def.label}」单一视角攻击式审查。\n` +
    `${def.probeFocus}\n\n` +
    `检查点清单（报告时必须引用检查点 id，每个发现对应一个检查点）：\n${checklist}\n\n` +
    `输出要求：只输出一个 JSON 数组，不要输出任何其他文字或代码块标记。\n` +
    `数组元素结构：\n` +
    `{"checkpoint":"检查点id","title":"一句话标题","file":"文件路径","line":行号或null,"detail":"问题描述（含触发条件）","evidence":"证据：代码片段或调用链","suggestion":"具体修复建议","impact":0-3,"confidence":0-3}\n` +
    `约束：\n` +
    `- file 必须取自文件清单；line 为新文件 1 起行号，无法定位填 null。\n` +
    `- impact：0 无影响 / 1 轻微 / 2 显著 / 3 致命；confidence：0 猜测 / 1 存疑 / 2 较有把握 / 3 确凿。\n` +
    `- 最多报告 ${limits.maxFindingsPerLens} 条；宁缺毋滥，没有真实问题返回 []。`;

  const user =
    `文件清单：${fileList}\n` +
    `上下文（行号 | 标记 + 内容，标记 + 为新增、- 为删除、空格为上下文）：\n\n${context}`;

  let text: string;
  try {
    const result = await llm.complete({
      system,
      user,
      maxTokens: limits.maxTokens,
      temperature: DEFAULTS.temperature,
      signal,
    });
    text = result.text;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('审查已取消', 'AbortError');
    throw error;
  }

  const raw = extractJsonArray(text);
  if (raw == null) {
    failures.push({ lens, reason: '无法从输出解析 JSON 发现数组', raw: text.slice(0, 300) });
    return { findings: [], failures };
  }
  const findings: LensFinding[] = [];
  for (const item of raw) {
    const normalized = normalizeLensFinding(item, lens);
    if (!normalized) continue;
    // 模型必须引用文件清单内的路径；引用未知文件视为定位失败（file 置空）
    if (normalized.file && !validFiles.has(normalized.file)) {
      normalized.file = null;
      normalized.line = null;
    }
    findings.push(normalized);
    if (findings.length >= limits.maxFindingsPerLens) break;
  }
  return { findings, failures };
}

/** 深度复核：对候选发现逐条挑战，返回确认/驳回判定。 */
async function deepChallenge(
  top: MergedFinding[],
  llm: LlmClient,
  signal: AbortSignal | undefined,
): Promise<{ decisions: Array<'confirmed' | 'refuted' | 'unchanged'>; failures: ParseFailure[] }> {
  const list = top
    .map(
      (f, index) =>
        `[${index}] ${f.file ?? '(未知文件)'}:${f.line ?? '?'} ｜ ${f.title}（影响${f.impact}/置信${f.confidence}）\n    ${f.detail.slice(0, 160)}`,
    )
    .join('\n');
  const system =
    '你是审查仲裁员。下面是一份多视角审查产生的候选问题清单。' +
    '你的任务是逐条挑战式复核：站在“提出者”的对立面试图反驳每一条。' +
    '只有在你无法构造反驳、或反驳不成立时才确认。' +
    '对每条给出判定，宁可漏判（保持原状）也不冤枉。' +
    '只输出 JSON，不要其他文字：' +
    '{"confirmations":[{"index":0,"note":"确认理由"}],"refutations":[{"index":1,"reason":"驳回理由"}]}' +
    '未提到的条目视为“不改变原判定”。';
  const user = `候选清单：\n${list}`;
  try {
    const result = await llm.complete({
      system,
      user,
      maxTokens: 1_500,
      temperature: 0,
      signal,
    });
    const raw = extractJsonObject(result.text);
    const decisions: Array<'confirmed' | 'refuted' | 'unchanged'> = top.map(() => 'unchanged');
    if (raw != null) {
      const confirmations = Array.isArray(raw.confirmations) ? raw.confirmations : [];
      const refutations = Array.isArray(raw.refutations) ? raw.refutations : [];
      for (const item of confirmations) {
        const index = Number(item?.index);
        if (Number.isInteger(index) && index >= 0 && index < decisions.length) {
          decisions[index] = 'confirmed';
        }
      }
      for (const item of refutations) {
        const index = Number(item?.index);
        if (Number.isInteger(index) && index >= 0 && index < decisions.length) {
          decisions[index] = 'refuted';
        }
      }
    } else {
      return {
        decisions,
        failures: [{ lens: 'deep', reason: '无法从复核输出解析 JSON', raw: result.text.slice(0, 300) }],
      };
    }
    return { decisions, failures: [] };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('审查已取消', 'AbortError');
    throw error;
  }
}

/** 案卷记录：追加本次摘要，返回对照统计。取消信号在写入前再次检查。 */
async function recordHistory(
  history: HistoryStore | undefined,
  signal: AbortSignal | undefined,
  input: {
    id: string;
    startedAt: string;
    findings: MergedFinding[];
    suppressedCount: number;
    scope: ResolvedScope;
  },
): Promise<ReviewReport['history']> {
  if (!history) return undefined;
  const entries = await history.recent(500).catch(() => []);
  throwIfAborted(signal);
  const bySeverity: Record<string, number> = {};
  for (const finding of input.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  await history.append({
    id: input.id,
    ts: input.startedAt,
    engineVersion: ENGINE_VERSION,
    scope: { kind: input.scope.kind, files: input.scope.files.map((f) => f.path) },
    counts: { findings: input.findings.length, suppressed: input.suppressedCount, bySeverity },
    fingerprints: input.findings.map((f) => ({
      fingerprint: f.fingerprint,
      severity: f.severity,
      file: f.file,
      line: f.line,
      title: f.title,
    })),
  }).catch((error) => {
    console.warn(`gavel: 案卷写入失败（不影响本次审查）: ${(error as Error).message}`);
  });
  return {
    known: input.findings.filter((f) => f.known).length,
    runs: entries.length, // 本次之前的运行次数
  };
}

function buildStats(
  scope: ResolvedScope,
  tripwireHits: number,
  allCandidates: Candidate[],
  findings: MergedFinding[],
  filtered: ReturnType<typeof applyRules>,
  parseFailures: ParseFailure[],
): ReviewReport['stats'] {
  const bySeverity: ReviewReport['stats']['bySeverity'] = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  let addedLines = 0;
  let removedLines = 0;
  let hunks = 0;
  for (const file of scope.files) {
    if (!file.hunks) continue;
    hunks += file.hunks.length;
    for (const group of file.hunks) {
      for (const line of group) {
        if (line.type === 'add') addedLines++;
        else if (line.type === 'del') removedLines++;
      }
    }
  }
  return {
    files: scope.files.length,
    hunks,
    addedLines,
    removedLines,
    tripwireHits,
    lensFindings: allCandidates.filter((c) => 'lens' in c && c.lens !== 'tripwire').length,
    mergedFindings: findings.length,
    suppressed: filtered.suppressed.length,
    parseFailures: parseFailures.length,
    known: findings.filter((f) => f.known).length,
    bySeverity,
  };
}

/** 从模型输出中提取 JSON 数组；失败返回 null。 */
export function extractJsonArray(text: string): unknown[] | null {
  const cleaned = stripFences(text.trim());
  // 模型可能在 JSON 前夹带说明文字：逐个 [ 候选尝试解析。
  // 候选数量受限，避免大段无合法 JSON 的文本造成 O(n²) 扫描。
  const MAX_CANDIDATES = 16;
  let searchFrom = 0;
  let attempts = 0;
  while (attempts < MAX_CANDIDATES) {
    const arrayStart = cleaned.indexOf('[', searchFrom);
    if (arrayStart === -1) break;
    attempts++;
    const end = findJsonEnd(cleaned, arrayStart, ']');
    if (end !== -1) {
      try {
        const parsed = JSON.parse(cleaned.slice(arrayStart, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // 该候选非法，继续找下一个（从下一字符重新扫描，嵌套数组可能在失败区间内）
      }
    }
    searchFrom = arrayStart + 1;
  }
  // 整段解析兜底
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从模型输出中提取 JSON 对象；失败返回 null。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripFences(text.trim());
  const MAX_CANDIDATES = 16;
  let searchFrom = 0;
  let attempts = 0;
  while (attempts < MAX_CANDIDATES) {
    const objectStart = cleaned.indexOf('{', searchFrom);
    if (objectStart === -1) break;
    attempts++;
    const end = findJsonEnd(cleaned, objectStart, '}');
    if (end !== -1) {
      try {
        const parsed = JSON.parse(cleaned.slice(objectStart, end + 1));
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // 继续找下一个
      }
    }
    searchFrom = objectStart + 1;
  }
  try {
    const parsed = JSON.parse(cleaned);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 去除 ``` 代码围栏。 */
function stripFences(text: string): string {
  let result = text;
  if (result.startsWith('```')) {
    const firstNewline = result.indexOf('\n');
    if (firstNewline !== -1) result = result.slice(firstNewline + 1);
    else result = '';
  }
  if (result.endsWith('```')) result = result.slice(0, -3);
  return result.trim();
}

/** 从 start 位置开始扫描，返回配对的结束括号下标（处理字符串与转义）。 */
function findJsonEnd(text: string, start: number, close: ']' | '}'): number {
  const open = close === ']' ? '[' : '{';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 归一化单条透镜发现；结构非法返回 null。 */
export function normalizeLensFinding(item: unknown, lens: LensId): LensFinding | null {
  if (item == null || typeof item !== 'object' || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return null;

  // 仅接受有限数值（null/布尔/非数字视为缺失，回退默认值）
  const toInt = (value: unknown, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(3, Math.max(0, Math.round(value)));
  };
  const toLine = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
    return value;
  };
  const toText = (value: unknown): string =>
    typeof value === 'string' ? value.trim().slice(0, 1000) : '';

  return {
    lens,
    checkpoint: toText(record.checkpoint),
    title: title.slice(0, 200),
    file: toText(record.file) || null,
    line: toLine(record.line),
    detail: toText(record.detail),
    evidence: toText(record.evidence),
    suggestion: toText(record.suggestion),
    impact: toInt(record.impact, 1) as 0 | 1 | 2 | 3,
    confidence: toInt(record.confidence, 1) as 0 | 1 | 2 | 3,
  };
}
