/**
 * 模型输出解析测试：JSON 提取的容错性与发现归一化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonArray, extractJsonObject, normalizeLensFinding } from '../src/core/engine.ts';

const GOOD = JSON.stringify([
  { title: '问题甲', checkpoint: 'C01', file: 'a.ts', line: 3, impact: 2, confidence: 2 },
]);

test('前置说明文字 + JSON 数组', () => {
  const parsed = extractJsonArray(`以下是我发现的问题：\n${GOOD}`);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed!.length, 1);
});

test('围栏内 JSON 数组', () => {
  const parsed = extractJsonArray('```json\n' + GOOD + '\n```');
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed!.length, 1);
});

test('多个候选片段中取第一个合法 JSON', () => {
  const parsed = extractJsonArray(`先看 [这里] 的说明：\n[{"title":"x"},{"title":"y"}] 以及更多`);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed!.length, 2);
});

test('非法输入返回 null', () => {
  assert.equal(extractJsonArray('完全不是 JSON'), null);
  assert.equal(extractJsonArray('{"object": "不是数组"}'), null);
  assert.equal(extractJsonObject('[]'), null);
  assert.equal(extractJsonObject('不是 JSON'), null);
});

test('对象提取支持前置文字', () => {
  const parsed = extractJsonObject('结论：{"confirmations":[{"index":0}],"refutations":[]}');
  assert.ok(parsed);
  assert.equal((parsed!.confirmations as unknown[]).length, 1);
});

test('归一化：null/布尔/缺失字段回退默认值', () => {
  const finding = normalizeLensFinding(
    {
      title: '测试',
      checkpoint: 'C01',
      file: 'a.ts',
      line: 5,
      impact: null,
      confidence: true,
    },
    'correctness',
  );
  assert.ok(finding);
  assert.equal(finding!.impact, 1, 'null 影响度回退默认 1');
  assert.equal(finding!.confidence, 1, '布尔置信度回退默认 1');
});

test('归一化：行号非法归 null，标题缺失丢弃', () => {
  const badLine = normalizeLensFinding({ title: 'x', line: 0, file: 'a.ts' }, 'security');
  assert.equal(badLine!.line, null);
  assert.equal(normalizeLensFinding({ checkpoint: 'C01' }, 'security'), null);
  assert.equal(normalizeLensFinding('字符串', 'security'), null);
  assert.equal(normalizeLensFinding(null, 'security'), null);
  assert.equal(normalizeLensFinding([], 'security'), null);
});
