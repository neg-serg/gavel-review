/**
 * 报告渲染测试：Markdown 结构完整性、JSON 序列化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, toJson } from '../src/core/report.ts';
import { runReview } from '../src/core/engine.ts';
import type { ReviewReport } from '../src/core/types.ts';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@
 const x = 1;
+const apiKey = "sk-abcdef123456";
+const name = user.name;
`;

const LENS_RESPONSE = JSON.stringify([
  {
    checkpoint: 'C01',
    title: '空值解引用崩溃',
    file: 'src/a.ts',
    line: 4,
    detail: 'user 可能为 null',
    evidence: 'user 来自外部输入',
    suggestion: '判空',
    impact: 3,
    confidence: 3,
  },
]);

async function sampleReport(): Promise<ReviewReport> {
  return runReview(
    {
      scope: { kind: 'diff', diffText: DIFF },
      lenses: ['correctness', 'security', 'maintainability'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: {
        async complete({ system }) {
          if (system?.includes('正确性')) return { text: LENS_RESPONSE };
          return { text: '[]' };
        },
      },
    },
  );
}

test('Markdown 报告包含关键区块', async () => {
  const report = await sampleReport();
  const md = renderMarkdown(report);
  assert.ok(md.includes('# 对抗式代码审查报告'));
  assert.ok(md.includes(`运行 id`));
  assert.ok(md.includes('阻断发布'));
  assert.ok(md.includes('空值解引用崩溃'));
  assert.ok(md.includes('src/a.ts:4'));
  assert.ok(md.includes('检查点：C01'));
  assert.ok(md.includes('硬编码凭据') || md.includes('疑似硬编码'));
  assert.ok(md.includes('由 gavel-review 生成'));
});

test('空报告渲染不报错且提示无问题', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: '' },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    { llm: { async complete() { return { text: '[]' }; } } },
  );
  const md = renderMarkdown(report);
  assert.ok(md.includes('未发现值得报告的问题'));
});

test('JSON 序列化往返一致', async () => {
  const report = await sampleReport();
  const json = toJson(report);
  const parsed = JSON.parse(json) as ReviewReport;
  assert.equal(parsed.id, report.id);
  assert.equal(parsed.findings.length, report.findings.length);
  assert.deepEqual(parsed.stats, report.stats);
  assert.equal(parsed.findings[0]!.severity, report.findings[0]!.severity);
});

test('报告含抑制与解析失败区块时正常渲染', async () => {
  const report = await sampleReport();
  report.suppressed = [
    {
      ruleId: 'r-001',
      finding: report.findings[0]!,
    },
  ];
  report.parseFailures = [{ lens: 'security', reason: '解析失败', raw: 'xx' }];
  report.generatedRules = [
    { id: 'r-001', file: '**', source: 'any', key: '空值', reason: '自动', createdAt: 'x' },
  ];
  const md = renderMarkdown(report);
  assert.ok(md.includes('被抑制的发现'));
  assert.ok(md.includes('解析失败警告'));
  assert.ok(md.includes('生成的抑制规则'));
  assert.ok(md.includes('r-001'));
});
