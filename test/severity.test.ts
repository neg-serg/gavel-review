/**
 * 严重度定级测试：分值计算、级别映射、上下界与佐证加成。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, levelForScore, severityRank, severityLabel } from '../src/core/severity.ts';

test('分值 = 影响×2 + 置信度，上限 10', () => {
  assert.equal(computeScore(3, 3, false), 9);
  assert.equal(computeScore(3, 3, true), 10);
  assert.equal(computeScore(0, 0, false), 0);
  assert.equal(computeScore(2, 2, false), 6);
  assert.equal(computeScore(2, 2, true), 7);
});

test('越界输入被钳制', () => {
  assert.equal(computeScore(99, -5, false), 6); // 3*2 + 0
  assert.equal(computeScore(-1, 100, true), 4); // 0*2 + 3 + 1
});

test('级别映射边界', () => {
  assert.equal(levelForScore(9), 'blocker');
  assert.equal(levelForScore(8), 'required');
  assert.equal(levelForScore(7), 'required');
  assert.equal(levelForScore(6), 'recommended');
  assert.equal(levelForScore(5), 'recommended');
  assert.equal(levelForScore(4), 'optional');
  assert.equal(levelForScore(3), 'optional');
  assert.equal(levelForScore(2), 'informational');
  assert.equal(levelForScore(0), 'informational');
});

test('佐证加成可使 required 升为 blocker', () => {
  assert.equal(levelForScore(computeScore(3, 2, false)), 'required');
  assert.equal(levelForScore(computeScore(3, 2, true)), 'blocker');
});

test('排序权重单调递增', () => {
  const levels = ['informational', 'optional', 'recommended', 'required', 'blocker'];
  const ranks = levels.map(severityRank);
  assert.deepEqual(ranks, [1, 2, 3, 4, 5]);
});

test('级别中文名齐全', () => {
  for (const level of ['informational', 'optional', 'recommended', 'required', 'blocker'] as const) {
    assert.ok(severityLabel(level).length > 0);
  }
});
