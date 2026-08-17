/**
 * 合并与去重测试：聚类、指纹稳定性、佐证计数、排序。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterCandidates,
  mergeCandidates,
  fingerprintOf,
  significantTokens,
  tokenOverlap,
} from '../src/core/merge.ts';
import type { LensFinding } from '../src/core/types.ts';

function lensFinding(partial: Partial<LensFinding> & { lens: LensFinding['lens']; title: string }): LensFinding {
  return {
    checkpoint: 'C01',
    file: null,
    line: null,
    detail: '',
    evidence: '',
    suggestion: '',
    impact: 1,
    confidence: 1,
    ...partial,
  };
}

test('同文件邻近行且同检查点的跨透镜发现合并为一', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '空指针崩溃风险', file: 'a.ts', line: 10, checkpoint: 'C01', impact: 3, confidence: 3 }),
    lensFinding({ lens: 'security', title: '未校验空值导致崩溃', file: 'a.ts', line: 12, checkpoint: 'C01', impact: 2, confidence: 2 }),
  ];
  const merged = mergeCandidates(candidates);
  assert.equal(merged.length, 1);
  const finding = merged[0]!;
  assert.deepEqual(finding.lenses.sort(), ['correctness', 'security']);
  assert.equal(finding.source, 'lens');
  assert.equal(finding.score, 10); // 3*2+3+佐证1
  assert.equal(finding.severity, 'blocker');
});

test('行号相距远的同检查点发现不合并', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '空指针', file: 'a.ts', line: 10, checkpoint: 'C01' }),
    lensFinding({ lens: 'security', title: '空值处理', file: 'a.ts', line: 90, checkpoint: 'C01' }),
  ];
  assert.equal(mergeCandidates(candidates).length, 2);
});

test('不同文件不合并', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '越界访问', file: 'a.ts', line: 5 }),
    lensFinding({ lens: 'security', title: '越界访问', file: 'b.ts', line: 5 }),
  ];
  assert.equal(mergeCandidates(candidates).length, 2);
});

test('无行号发现按标题词元归入邻近簇', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '数据库连接泄漏', file: 'a.ts', line: 20 }),
    lensFinding({ lens: 'maintainability', title: '数据库连接未释放', file: 'a.ts', line: 22, checkpoint: 'M01' }),
    lensFinding({ lens: 'security', title: '数据库连接泄漏风险', file: null, line: null, checkpoint: 'S05' }),
  ];
  const merged = mergeCandidates(candidates);
  // 前两个同簇；第三个无行号但词元重叠（数据库/连接/泄漏）≥2 归入同一簇
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.lenses.sort(), ['correctness', 'maintainability', 'security']);
});

test('不相关的邻近发现（不同检查点且词元不重叠）不合并', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '数组越界访问', file: 'a.ts', line: 10, checkpoint: 'C02' }),
    lensFinding({ lens: 'maintainability', title: '函数过长应拆分', file: 'a.ts', line: 11, checkpoint: 'M01' }),
  ];
  assert.equal(mergeCandidates(candidates).length, 2);
});

test('邻近行的不同哨兵规则不误合并（检查点按规则区分）', () => {
  const tripwire = (ruleId: string, ruleName: string, line: number) => ({
    lens: 'tripwire' as const,
    ruleId,
    ruleName,
    category: '可维护性',
    file: 'a.ts',
    line,
    snippet: 'x',
    impact: 1 as const,
    confidence: 2 as const,
    suggestion: 's',
  });
  const candidates = [
    tripwire('console-log', '调试日志输出', 10),
    tripwire('todo-marker', '未完成标记', 12),
  ];
  const merged = mergeCandidates(candidates);
  assert.equal(merged.length, 2, '不同规则即使行邻近也应各自成簇');
  // 同一规则在邻近行的多次命中仍合并为一
  const same = mergeCandidates([tripwire('console-log', '调试日志输出', 10), tripwire('console-log', '调试日志输出', 12)]);
  assert.equal(same.length, 1);
  // 纯哨兵簇的检查点标记保持 TRIPWIRE
  assert.equal(merged[0]!.checkpoint, 'TRIPWIRE');
});

test('哨兵与透镜同处问题合并为 mixed，佐证生效', () => {
  const candidates = [
    lensFinding({ lens: 'security', title: '硬编码的 API 密钥泄露风险', file: 'c.ts', line: 3, checkpoint: 'S02' }),
    {
      lens: 'tripwire' as const,
      ruleId: 'hardcoded-secret',
      ruleName: '疑似硬编码凭据',
      category: '安全',
      file: 'c.ts',
      line: 3,
      snippet: 'const apiKey = "sk-123"',
      impact: 3 as const,
      confidence: 2 as const,
      suggestion: '移入环境变量',
    },
  ];
  const merged = mergeCandidates(candidates);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.source, 'mixed');
  assert.equal(merged[0]!.ruleId, 'hardcoded-secret');
  assert.equal(merged[0]!.score, 9); // 3*2 + 2 + 佐证1
  assert.equal(merged[0]!.severity, 'blocker');
});

test('指纹：同问题（行漂移 10 行内）指纹一致，不同标题不一致', () => {
  const a = fingerprintOf('src/a.ts', 42, '空指针解引用崩溃');
  const b = fingerprintOf('src/a.ts', 45, '空指针解引用崩溃');
  const c = fingerprintOf('src/a.ts', 42, '数组越界写入');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('指纹：聚类半径外的相邻问题指纹不冲突', () => {
  // 行距 7（> 邻近阈值 6）的两个问题不应共享指纹
  const a = fingerprintOf('src/a.ts', 10, '数据库连接泄漏');
  const b = fingerprintOf('src/a.ts', 17, '数据库连接泄漏');
  assert.notEqual(a, b);
  // 行漂移 5（聚类半径内）指纹稳定
  assert.equal(fingerprintOf('src/a.ts', 42, '空指针解引用'), fingerprintOf('src/a.ts', 45, '空指针解引用'));
});

test('known 标记：指纹在历史集合中的发现被标记', () => {
  const candidates = [
    lensFinding({ lens: 'correctness', title: '空指针解引用', file: 'a.ts', line: 10 }),
  ];
  const known = new Set([fingerprintOf('a.ts', 10, '空指针解引用')]);
  const merged = mergeCandidates(candidates, known);
  assert.equal(merged[0]!.known, true);
});

test('significantTokens 去除停用词与单字符', () => {
  const tokens = significantTokens('The function may crash on empty input for the API');
  assert.deepEqual(tokens, ['function', 'crash', 'empty', 'input', 'api']);
  assert.deepEqual(significantTokens('a b c'), []);
});

test('tokenOverlap 计算交集', () => {
  assert.equal(tokenOverlap('数据库连接泄漏', '数据库连接未释放'), 4);
  assert.equal(tokenOverlap('数组越界访问', '函数过长拆分'), 0);
});

test('clusterCandidates 输出簇锚点行号', () => {
  const clusters = clusterCandidates([
    lensFinding({ lens: 'correctness', title: '问题甲', file: 'a.ts', line: 30 }),
    lensFinding({ lens: 'security', title: '问题乙', file: 'a.ts', line: 31, checkpoint: 'C01' }),
    lensFinding({ lens: 'maintainability', title: '问题丙', file: 'b.ts', line: 1 }),
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0]!.anchorLine, 30);
});
