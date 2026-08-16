/**
 * 案卷（历史）测试：JSONL 追加/读取、截断、统计、损坏行容忍。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlDocket, summarize } from '../src/core/docket.ts';
import type { DocketEntry } from '../src/core/types.ts';

function entry(id: string, ts: string, count = 1, fat = false): DocketEntry {
  return {
    id,
    ts,
    engineVersion: 'test',
    scope: { kind: 'diff', files: ['a.ts'] },
    counts: { findings: count, suppressed: 0, bySeverity: { required: count } },
    fingerprints: Array.from({ length: count }, (_, i) => ({
      fingerprint: `fp-${id}-${i}`,
      severity: 'required' as const,
      file: 'a.ts',
      line: 1,
      title: fat ? 't'.repeat(700) : 't',
    })),
  };
}

test('append 后 recent 可读回，顺序保持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-docket-'));
  const docket = new JsonlDocket(dir);
  await docket.append(entry('r1', '2026-01-01T00:00:00Z'));
  await docket.append(entry('r2', '2026-01-02T00:00:00Z'));
  const recent = await docket.recent(5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.id, 'r1');
  assert.equal(recent[1]!.id, 'r2');
  rmSync(dir, { recursive: true, force: true });
});

test('recent(n) 只取尾部 n 条', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-docket-'));
  const docket = new JsonlDocket(dir);
  for (let i = 0; i < 5; i++) await docket.append(entry(`r${i}`, `2026-01-0${i + 1}T00:00:00Z`));
  const recent = await docket.recent(2);
  assert.deepEqual(recent.map((e) => e.id), ['r3', 'r4']);
  rmSync(dir, { recursive: true, force: true });
});

test('损坏行被跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-docket-'));
  const docket = new JsonlDocket(dir);
  await docket.append(entry('r1', '2026-01-01T00:00:00Z'));
  const file = join(dir, 'docket.jsonl');
  const raw = readFileSync(file, 'utf8');
  await docket.append(entry('r2', '2026-01-02T00:00:00Z'));
  // 注入损坏行
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, 'this is not json\n', 'utf8');
  const recent = await docket.recent(10);
  assert.equal(recent.length, 2);
  assert.ok(raw.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test('超出上限自动截断：条目数与字节预算双约束', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-docket-'));
  const docket = new JsonlDocket(dir);
  for (let i = 0; i < 505; i++) await docket.append(entry(`r${i}`, `2026-01-01T00:00:00Z`, 1, true));
  const recent = await docket.recent(1000);
  // 条目上限：不超 500；字节预算：文件不超阈值
  assert.ok(recent.length <= 500);
  const size = statSync(join(dir, 'docket.jsonl')).size;
  assert.ok(size <= 256 * 1024, `案卷文件应被截断到字节预算内（实际 ${size} 字节）`);
  // 最新条目必须保留
  assert.equal(recent[recent.length - 1]!.id, 'r504');
  rmSync(dir, { recursive: true, force: true });
});

test('summarize 统计正确', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-docket-'));
  const docket = new JsonlDocket(dir);
  await docket.append(entry('r1', '2026-01-01T00:00:00Z', 2));
  await docket.append(entry('r2', '2026-01-02T00:00:00Z', 3));
  const stats = summarize(await docket.recent(10));
  assert.equal(stats.runs, 2);
  assert.equal(stats.totalFindings, 5);
  assert.equal(stats.bySeverity['required'], 5);
  assert.equal(stats.topFiles[0]!.file, 'a.ts');
  assert.equal(stats.topFiles[0]!.count, 5);
  assert.equal(stats.firstTs, '2026-01-01T00:00:00Z');
  assert.equal(stats.lastTs, '2026-01-02T00:00:00Z');
  rmSync(dir, { recursive: true, force: true });
});

test('目录不存在时自动创建', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-parent-'));
  const nested = join(dir, 'a', 'b');
  const docket = new JsonlDocket(nested);
  await docket.append(entry('r1', '2026-01-01T00:00:00Z'));
  assert.equal((await docket.recent(5)).length, 1);
  rmSync(dir, { recursive: true, force: true });
});
