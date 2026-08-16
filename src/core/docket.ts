/**
 * 审查历史（案卷）：JSONL 追加式存储。
 *
 * 每条记录是一次审查的摘要（指纹集合），用于：
 * - 增量审查：新报告中标记“已知问题”（known）与复发趋势；
 * - 统计：`gavel history --stats`。
 *
 * 存储失败不阻断审查（历史是增强能力，不是硬依赖）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DocketEntry, HistoryStore } from './types.ts';

/** 单个案卷文件最多保留的条目数（超出时截断尾部）。 */
const MAX_ENTRIES = 500;
/** 触发截断的文件字节阈值（约 500 条摘要的体量）。 */
const MAX_BYTES = 256 * 1024;
/** JSONL 案卷实现。 */
export class JsonlDocket implements HistoryStore {
  readonly file: string;

  constructor(directory: string, filename = 'docket.jsonl') {
    this.file = join(directory, filename);
  }

  /** 追加一条审查摘要（尽力而为，失败仅告警）。 */
  async append(entry: DocketEntry): Promise<void> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
      await this.pruneIfNeeded();
    } catch (error) {
      console.warn(`gavel: 案卷写入失败（不影响本次审查）: ${(error as Error).message}`);
    }
  }

  /** 读取最近 n 条（按写入顺序取尾部）。 */
  async recent(n: number): Promise<DocketEntry[]> {
    if (n <= 0) return [];
    try {
      if (!existsSync(this.file)) return [];
      const raw = readFileSync(this.file, 'utf8');
      const entries: DocketEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line) as DocketEntry);
        } catch {
          // 跳过损坏行（仅追加写入下不应发生，防御性处理）
        }
      }
      return entries.slice(-n);
    } catch {
      return [];
    }
  }

  /** 读取全部指纹集合（供增量对照）。 */
  async allFingerprints(): Promise<Set<string>> {
    const entries = await this.recent(Number.MAX_SAFE_INTEGER);
    return new Set(entries.flatMap((e) => e.fingerprints.map((f) => f.fingerprint)));
  }

  /** 文件超限时截断：条目数与字节预算双约束，写入为临时文件 + 原子替换。 */
  private async pruneIfNeeded(): Promise<void> {
    try {
      let size = 0;
      try {
        size = statSync(this.file).size;
      } catch {
        return; // 文件不存在
      }
      if (size <= MAX_BYTES) return;
      const entries = await this.recent(Number.MAX_SAFE_INTEGER);
      // 逐条尺寸预计算，循环内只做减法，避免 O(n²) 重复序列化
      const sizes = entries.map((e) => JSON.stringify(e).length + 1);
      let total = sizes.reduce((sum, s) => sum + s, 0);
      let start = 0;
      while (entries.length - start > MAX_ENTRIES || total > MAX_BYTES) {
        if (entries.length - start <= 1) break;
        total -= sizes[start] ?? 0;
        start++;
      }
      const tail = entries.slice(start);
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${tail.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch {
      // 截断失败不影响主流程
    }
  }
}

/** 案卷统计。 */
export interface DocketStats {
  runs: number;
  firstTs: string | null;
  lastTs: string | null;
  totalFindings: number;
  bySeverity: Record<string, number>;
  topFiles: Array<{ file: string; count: number }>;
}

/** 计算案卷统计（对形状不完整的记录做防御性处理）。 */
export function summarize(entries: DocketEntry[]): DocketStats {
  const bySeverity: Record<string, number> = {};
  const fileCounts = new Map<string, number>();
  let totalFindings = 0;
  for (const entry of entries) {
    const counts = entry.counts;
    const bySeverityOf = counts?.bySeverity ?? {};
    for (const [level, count] of Object.entries(bySeverityOf)) {
      bySeverity[level] = (bySeverity[level] ?? 0) + count;
    }
    const fingerprints = entry.fingerprints ?? [];
    for (const fp of fingerprints) {
      totalFindings++;
      const file = fp.file ?? '(未知文件)';
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  const topFiles = [...fileCounts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    runs: entries.length,
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries[entries.length - 1]?.ts ?? null,
    totalFindings,
    bySeverity,
    topFiles,
  };
}
