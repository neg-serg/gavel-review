/**
 * 合并与去重（仲裁层）：
 * 1. 跨透镜按「文件 + 行号邻近 + 标题词元重叠」聚类；
 * 2. 簇内取最高影响/置信度，合并描述与证据；
 * 3. 生成稳定指纹（供历史对照与抑制规则匹配）；
 * 4. 计算佐证加成与严重度。
 */

import { createHash } from 'node:crypto';
import type { LensFinding, MergedFinding, SeverityLevel, TripwireHit } from './types.ts';
import { normalizePath } from './diff.ts';
import { computeScore, levelForScore, severityRank } from './severity.ts';

/** 聚类时的行号邻近阈值（指纹行号桶与之一致，避免桶宽于聚类半径）。 */
const LINE_PROXIMITY = 6;
/** 聚类时标题词元重叠阈值。 */
const TOKEN_OVERLAP_THRESHOLD = 2;

/** 参与聚类的候选：透镜发现或哨兵命中。 */
export type Candidate = LensFinding | (TripwireHit & { lens: 'tripwire' });

/** 停用词：不参与标题词元比较。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'when', 'can', 'may',
  'should', 'will', 'not', 'have', 'has', 'are', 'was', 'were', 'would',
  'could', 'there', 'into', 'over', 'after', 'before', 'while', 'using',
  'used', 'use', 'code', 'line', 'file', 'issue', 'problem', 'bug',
  'likely', 'possible', 'potentially', 'potential', 'case', 'in',
  'on', 'at', 'of', 'a', 'an', 'is', 'it', 'its', 'be', 'been', 'being',
  'do', 'does', 'did', 'get', 'gets', 'must', 'need', 'needs',
]);

/**
 * 提取标题中的“有效词元”（小写、去停用词、长度 >= 2、去纯数字）。
 * 拉丁文本按词切分；CJK 连续段按滑动二元组切分（中文无词边界，整句
 * 视为一个 token 会令相似标题完全无法比较）。
 */
/** 词元缓存：聚类是 O(n²) 比较，避免重复分词。 */
const TOKEN_CACHE = new Map<string, string[]>();
const TOKEN_CACHE_MAX = 10_000;

export function significantTokens(text: string): string[] {
  const cached = TOKEN_CACHE.get(text);
  if (cached) return cached;
  const tokens = computeTokens(text);
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(text, tokens);
  return tokens;
}

function computeTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (token: string) => {
    if (token.length < 2 || STOPWORDS.has(token) || /^\d+$/.test(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const part of lower.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!part) continue;
    if (/[\u4e00-\u9fff]/.test(part)) {
      const chars = [...part];
      if (chars.length === 1) {
        add(chars[0]!);
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i++) {
        add(chars[i]! + chars[i + 1]!);
      }
      add(part); // 整体也保留，供指纹与关键词使用
    } else {
      add(part);
    }
  }
  return tokens;
}

/** 指纹：文件 + 行号桶（与聚类半径一致，容忍行漂移且不与聚类冲突）+ 标题前 5 个有效词元。 */
export function fingerprintOf(
  file: string | null,
  line: number | null,
  title: string,
): string {
  const fileKey = file ? normalizePath(file) : '?';
  const lineKey =
    line == null ? '?' : String(Math.floor(line / LINE_PROXIMITY) * LINE_PROXIMITY);
  const titleKey = significantTokens(title).slice(0, 5).join(' ');
  return createHash('sha1').update(`${fileKey}|${lineKey}|${titleKey}`).digest('hex').slice(0, 16);
}

/** 两个标题的共现词元数。 */
export function tokenOverlap(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = new Set(significantTokens(b));
  let count = 0;
  for (const token of ta) if (tb.has(token)) count++;
  return count;
}

/** 把一个候选转为统一的“定位键”。 */
function fileKeyOf(candidate: Candidate): string {
  return candidate.file ? normalizePath(candidate.file) : '?';
}

interface Cluster {
  members: Candidate[];
  /** 簇内按行号排序后的首个有行号成员作为锚点。 */
  anchorLine: number | null;
}

/**
 * 聚类：先按文件分组；组内按行号邻近 + 检查点分离 + 标题词元重叠合并。
 * 无行号的候选通过标题词元重叠归入现有簇。
 */
export function clusterCandidates(candidates: Candidate[]): Cluster[] {
  const byFile = new Map<string, Candidate[]>();
  const nullFile: Candidate[] = [];
  for (const candidate of candidates) {
    const key = fileKeyOf(candidate);
    if (key === '?') {
      nullFile.push(candidate);
      continue;
    }
    const list = byFile.get(key) ?? [];
    list.push(candidate);
    byFile.set(key, list);
  }

  const clusters: Cluster[] = [];
  for (const group of byFile.values()) {
    const withLine = group.filter((c) => c.line != null).sort((a, b) => a.line! - b.line!);
    const withoutLine = group.filter((c) => c.line == null);

    const fileClusters: Cluster[] = [];
    for (const candidate of withLine) {
      // 寻找可归属的现有簇：行号邻近，且（检查点相同 或 词元重叠达标）
      let joined = false;
      for (const cluster of fileClusters) {
        if (cluster.anchorLine == null) continue;
        const distance = Math.abs(candidate.line! - cluster.anchorLine);
        if (distance <= LINE_PROXIMITY) {
          const anchor = cluster.members[0]!;
          const sameCheckpoint = checkpointId(candidate) === checkpointId(anchor);
          if (sameCheckpoint || tokenOverlap(titleOf(candidate), titleOf(anchor)) >= TOKEN_OVERLAP_THRESHOLD) {
            cluster.members.push(candidate);
            cluster.anchorLine = Math.min(cluster.anchorLine, candidate.line!);
            joined = true;
            break;
          }
        }
      }
      if (!joined) fileClusters.push({ members: [candidate], anchorLine: candidate.line });
    }

    // 无行号的候选：优先按词元重叠归入本文件簇；否则自成一簇
    for (const candidate of withoutLine) {
      let joined = false;
      for (const cluster of fileClusters) {
        const anchor = cluster.members[0]!;
        if (tokenOverlap(titleOf(candidate), titleOf(anchor)) >= TOKEN_OVERLAP_THRESHOLD) {
          cluster.members.push(candidate);
          joined = true;
          break;
        }
      }
      if (!joined) fileClusters.push({ members: [candidate], anchorLine: null });
    }

    for (const cluster of fileClusters) {
      clusters.push(cluster);
    }
  }

  // 无文件定位的候选：跨文件按词元重叠尝试归入已有簇
  for (const candidate of nullFile) {
    let joined = false;
    for (const cluster of clusters) {
      const anchor = cluster.members[0]!;
      if (tokenOverlap(titleOf(candidate), titleOf(anchor)) >= TOKEN_OVERLAP_THRESHOLD) {
        cluster.members.push(candidate);
        joined = true;
        break;
      }
    }
    if (!joined) clusters.push({ members: [candidate], anchorLine: null });
  }
  return clusters;
}

/** 提取候选的检查点 id（C01/S02/M03 等）。 */
function checkpointId(candidate: Candidate): string {
  if ('checkpoint' in candidate && candidate.checkpoint) {
    return candidate.checkpoint.trim().split(/\s+/)[0] ?? '';
  }
  return 'tripwire';
}

/** 候选的“标题”：透镜发现用 title，哨兵命中用规则名。 */
function titleOf(candidate: Candidate): string {
  return 'title' in candidate ? candidate.title : candidate.ruleName;
}

/** 候选的“描述”。 */
function detailOf(candidate: Candidate): string {
  return 'detail' in candidate ? candidate.detail : candidate.snippet;
}

/** 候选的“证据”。 */
function evidenceOf(candidate: Candidate): string {
  return 'evidence' in candidate ? candidate.evidence : candidate.snippet;
}

/** 判断候选是否来自静态哨兵。 */
function isTripwire(candidate: Candidate): candidate is Extract<Candidate, { ruleId: string }> {
  return 'ruleId' in candidate;
}

/** 每个候选的源透镜集合。 */
function lensesOf(candidate: Candidate): Set<string> {
  if ('lens' in candidate && candidate.lens !== 'tripwire') return new Set([candidate.lens]);
  return new Set(['tripwire']);
}

/** 按严重度、分值、文件、行号排序的报告顺序。 */
export function sortFindings(findings: MergedFinding[]): MergedFinding[] {
  return [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return severityRank(b.severity) - severityRank(a.severity);
    if (a.score !== b.score) return b.score - a.score;
    if ((a.file ?? '?') !== (b.file ?? '?')) return (a.file ?? '?').localeCompare(b.file ?? '?');
    return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
  });
}

/** 去重后的证据列表（保序、截断）。 */
function mergeEvidence(evidenceList: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of evidenceList) {
    const normalized = raw.trim();
    if (!normalized) continue;
    const key = normalized.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized.slice(0, 500));
  }
  return result;
}

/** 判断指纹是否命中历史集合（容忍行漂移：同时检查邻近 ±1 个行号桶）。 */
function isKnown(
  fingerprint: string,
  file: string | null,
  line: number | null,
  title: string,
  known: ReadonlySet<string>,
): boolean {
  if (known.has(fingerprint)) return true;
  if (file == null || line == null) return false;
  // 桶边界漂移：同一问题在聚类半径内移动时桶可能变化，邻近桶一并纳入
  for (const delta of [-LINE_PROXIMITY, LINE_PROXIMITY]) {
    const shifted = line + delta;
    if (shifted < 1) continue;
    if (known.has(fingerprintOf(file, shifted, title))) return true;
  }
  return false;
}

/**
 * 合并全部候选为最终发现列表。
 * @param candidates - 透镜发现与哨兵命中的并集。
 * @param knownFingerprints - 历史中已存在的指纹集合（用于标记 known）。
 * @returns 排序后的发现列表。
 */
export function mergeCandidates(
  candidates: Candidate[],
  knownFingerprints: ReadonlySet<string> = new Set(),
): MergedFinding[] {
  const clusters = clusterCandidates(candidates);
  const findings: MergedFinding[] = [];

  for (const cluster of clusters) {
    // 簇内排序：分值优先；同分时透镜发现优先于哨兵（透镜标题更具描述性）
    const sorted = [...cluster.members].sort((a, b) => {
      const byScore = scoreOf(b) - scoreOf(a);
      if (byScore !== 0) return byScore;
      return (isTripwire(a) ? 1 : 0) - (isTripwire(b) ? 1 : 0);
    });
    const top = sorted[0]!;
    const allLenses = new Set<string>();
    for (const member of cluster.members) for (const lens of lensesOf(member)) allLenses.add(lens);
    const lensList = [...allLenses].filter((l) => l !== 'tripwire') as MergedFinding['lenses'];
    const corroborated = allLenses.size >= 2;
    const impact = Math.max(...cluster.members.map((m) => m.impact)) as 0 | 1 | 2 | 3;
    const confidence = Math.max(...cluster.members.map((m) => m.confidence)) as 0 | 1 | 2 | 3;
    const score = computeScore(impact, confidence, corroborated);

    const file = 'file' in top ? top.file : null;
    const line = cluster.anchorLine ?? null;
    const title = titleOf(top);
    const fingerprint = fingerprintOf(file, line, title);
    const checkpointMember =
      cluster.members.find((m) => 'checkpoint' in m && m.checkpoint) ?? top;
    const checkpoint =
      'checkpoint' in checkpointMember && checkpointMember.checkpoint
        ? checkpointMember.checkpoint
        : checkpointId(top) === 'tripwire'
          ? 'TRIPWIRE'
          : '';

    const detailParts = new Set<string>();
    for (const member of sorted) {
      const text = detailOf(member).trim();
      if (text) detailParts.add(text.slice(0, 600));
    }
    const detail = [...detailParts].join('；') || title;

    const evidence = mergeEvidence(
      cluster.members
        .filter((m) => evidenceOf(m).trim().length > 0)
        .map((m) => evidenceOf(m)),
    );
    const suggestion =
      sorted.map((m) => m.suggestion).find((s) => s && s.trim().length > 0) ?? '';

    const tripwireMember = cluster.members.find(isTripwire);
    const hasLensMember = cluster.members.some((m) => 'lens' in m && m.lens !== 'tripwire');

    findings.push({
      fingerprint,
      severity: severityOf(score),
      score,
      impact,
      confidence,
      source: tripwireMember ? (hasLensMember ? 'mixed' : 'tripwire') : 'lens',
      lenses: lensList,
      checkpoint,
      title,
      file,
      line,
      detail,
      evidence,
      suggestion,
      ...(tripwireMember ? { ruleId: tripwireMember.ruleId } : {}),
      known: isKnown(fingerprint, file, line, title, knownFingerprints),
    });
  }

  return sortFindings(findings);
}

/** 候选的原始分值（用于簇内排序）。 */
function scoreOf(candidate: Candidate): number {
  return computeScore(candidate.impact, candidate.confidence, false);
}

function severityOf(score: number): SeverityLevel {
  return levelForScore(score);
}
