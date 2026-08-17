/**
 * 引擎编排测试：并行透镜、失败容忍、深度复核、抑制、历史、取消。
 * 使用脚本化假模型，验证全流水线行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReview } from '../src/core/engine.ts';
import type { LlmClient } from '../src/core/types.ts';

/** 脚本化假模型：按系统提示词中的标记返回不同内容。 */
function fakeLlm(script: Record<string, string>): LlmClient {
  return {
    async complete({ system, user }) {
      const key = Object.keys(script).find((k) => system?.includes(k));
      if (key) return { text: script[key]! };
      if (user.includes('候选清单')) return { text: '{"confirmations":[],"refutations":[]}' };
      return { text: '[]' };
    },
  };
}

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,6 +1,8 @@
 const x = 1;
-const secret = "old";
+const apiKey = "sk-abcdef123456";
+const result = lookup(userId);
+if (result == null) {
+  return result.name;
+}
`;

const CORRECTNESS_RESPONSE = JSON.stringify([
  {
    checkpoint: 'C01',
    title: '空值解引用导致崩溃',
    file: 'src/a.ts',
    line: 7,
    detail: 'result 可能为 null 时直接访问 result.name',
    evidence: 'lookup 返回类型含 null',
    suggestion: '判空后再访问',
    impact: 3,
    confidence: 3,
  },
]);

const SECURITY_RESPONSE = JSON.stringify([
  {
    checkpoint: 'S02',
    title: '硬编码 API 密钥',
    file: 'src/a.ts',
    line: 3,
    detail: '密钥直接写入源码',
    evidence: 'apiKey = "sk-abcdef123456"',
    suggestion: '改用环境变量',
    impact: 3,
    confidence: 2,
  },
  {
    checkpoint: 'S01',
    title: '用户输入未校验',
    file: 'src/a.ts',
    line: 5,
    detail: 'userId 直接用于查询',
    evidence: 'lookup(userId)',
    suggestion: '校验输入格式',
    impact: 1,
    confidence: 1,
  },
]);

test('完整流水线：透镜并行 + 哨兵 + 合并 + 定级', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness', 'security'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: fakeLlm({
        '正确性': CORRECTNESS_RESPONSE,
        '安全性': SECURITY_RESPONSE,
      }),
    },
  );

  assert.equal(report.scope.files.length, 1);
  assert.equal(report.stats.files, 1);
  assert.equal(report.stats.addedLines, 5);
  // 哨兵命中硬编码密钥（新增行）
  assert.equal(report.stats.tripwireHits, 1);
  assert.equal(report.stats.lensFindings, 3);
  // 透镜「硬编码 API 密钥」与哨兵「hardcoded-secret」同文件同行 → mixed
  const merged = report.findings;
  assert.ok(merged.some((f) => f.source === 'mixed' && f.ruleId === 'hardcoded-secret'));
  assert.ok(merged.some((f) => f.title.includes('空值解引用') && f.severity === 'blocker'));
  // 定级检查：3*2+3 = 9 → blocker
  const nullFinding = merged.find((f) => f.title.includes('空值解引用'))!;
  assert.equal(nullFinding.score, 9);
  assert.equal(nullFinding.severity, 'blocker');
  // JSON 可序列化
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('透镜失败不影响整体：记录失败并继续', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness', 'security', 'maintainability'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: {
        async complete({ system }) {
          if (system?.includes('正确性')) throw new Error('模拟网络错误');
          if (system?.includes('安全性')) return { text: SECURITY_RESPONSE };
          return { text: '[]' };
        },
      },
    },
  );
  assert.equal(report.parseFailures.length, 1);
  assert.equal(report.parseFailures[0]!.lens, 'correctness');
  assert.ok(report.stats.mergedFindings >= 2);
});

test('透镜返回非法 JSON：解析失败被记录，无发现', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: fakeLlm({ '正确性': '抱歉，我无法输出 JSON' }),
    },
  );
  assert.equal(report.parseFailures.length, 1);
  assert.ok(report.parseFailures[0]!.reason.includes('JSON'));
  assert.equal(report.stats.lensFindings, 0);
  // 哨兵仍然工作
  assert.ok(report.stats.tripwireHits >= 1);
});

test('代码围栏包裹的 JSON 可被解析', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: fakeLlm({ '正确性': '```json\n' + CORRECTNESS_RESPONSE + '\n```' }),
    },
  );
  assert.equal(report.parseFailures.length, 0);
  assert.equal(report.stats.lensFindings, 1);
});

test('深度复核：驳回的发现降级为观察', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      deep: true,
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: {
        async complete({ system, user }) {
          if (system?.includes('正确性')) return { text: CORRECTNESS_RESPONSE };
          assert.ok(user.includes('候选清单'));
          return {
            text: '{"confirmations":[{"index":1,"note":"确实会崩"}],"refutations":[{"index":0,"reason":"此处必非空"}]}',
          };
        },
      },
    },
  );
  const refuted = report.findings.find((f) => f.title.includes('空值解引用'))!;
  assert.equal(refuted.verified, 'refuted');
  assert.equal(refuted.severity, 'informational');
  const confirmed = report.findings.find((f) => f.source === 'tripwire')!;
  assert.equal(confirmed.verified, 'confirmed');
});

test('深度复核调用失败：降级为解析失败，审查照常返回', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      deep: true,
      model: { provider: 'fake', model: 'fake-1' },
    },
    {
      llm: {
        async complete({ system, user }) {
          if (system?.includes('正确性')) return { text: CORRECTNESS_RESPONSE };
          assert.ok(user.includes('候选清单'));
          throw new Error('模拟深度复核网络中断');
        },
      },
    },
  );
  assert.ok(report.findings.length >= 1, '深度复核失败不应丢弃已有发现');
  assert.ok(report.parseFailures.some((f) => f.lens === 'deep'), '应记录 deep 解析失败');
  assert.ok(report.parseFailures.some((f) => f.reason.includes('深度复核调用失败')));
  assert.ok(report.findings.every((f) => f.verified === undefined), '失败时不应产生任何复核判定');
});

test('深度复核阶段取消：仍然中止整次审查', async () => {
  const controller = new AbortController();
  await assert.rejects(
    runReview(
      {
        scope: { kind: 'diff', diffText: SAMPLE_DIFF },
        lenses: ['correctness'],
        deep: true,
        model: { provider: 'fake', model: 'fake-1' },
        signal: controller.signal,
      },
      {
        llm: {
          async complete({ system }) {
            if (system?.includes('正确性')) return { text: CORRECTNESS_RESPONSE };
            controller.abort();
            throw new DOMException('已取消', 'AbortError');
          },
        },
      },
    ),
    (error: Error) => error.name === 'AbortError',
  );
});

test('抑制规则过滤达标问题', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['security'],
      model: { provider: 'fake', model: 'fake-1' },
      rules: [
        {
          id: 'r-test',
          file: 'src/**',
          source: 'any',
          key: '密钥',
          reason: '测试',
          createdAt: 'x',
        },
      ],
    },
    { llm: fakeLlm({ '安全性': SECURITY_RESPONSE }) },
  );
  assert.equal(report.stats.suppressed, 1);
  assert.equal(report.suppressed.length, 1);
  assert.equal(report.suppressed[0]!.ruleId, 'r-test');
  assert.ok(!report.findings.some((f) => f.title.includes('密钥')));
});

test('历史：二次审查相同问题被标记 known', async () => {
  const first = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
      history: {
        async append() {},
        async recent() {
          return [];
        },
      },
    },
    { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
  );
  const entries = [
    {
      id: 'prev',
      ts: '2026-01-01T00:00:00Z',
      engineVersion: 'test',
      scope: { kind: 'diff' as const, files: ['src/a.ts'] },
      counts: { findings: 1, suppressed: 0, bySeverity: {} },
      fingerprints: first.findings.map((f) => ({
        fingerprint: f.fingerprint,
        severity: f.severity,
        file: f.file,
        line: f.line,
        title: f.title,
      })),
    },
  ];
  const second = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
      history: {
        async append() {},
        async recent() {
          return entries;
        },
      },
    },
    { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
  );
  assert.equal(second.findings[0]!.known, true);
  assert.equal(second.history!.known, second.findings.filter((f) => f.known).length);
  assert.equal(second.history!.runs, 1);
});

test('取消信号中止审查', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runReview(
      {
        scope: { kind: 'diff', diffText: SAMPLE_DIFF },
        lenses: ['correctness'],
        model: { provider: 'fake', model: 'fake-1' },
        signal: controller.signal,
      },
      { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
    ),
    (error: Error) => error.name === 'AbortError',
  );
});

test('透镜阶段取消：立即中止且不写案卷', async () => {
  let appended = false;
  const controller = new AbortController();
  const report = runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness', 'security', 'maintainability'],
      model: { provider: 'fake', model: 'fake-1' },
      history: {
        async append() {
          appended = true;
        },
        async recent() {
          return [];
        },
      },
      signal: controller.signal,
    },
    {
      llm: {
        async complete({ system, signal }) {
          if (system?.includes('正确性')) {
            // 模拟该透镜调用期间收到取消
            setTimeout(() => controller.abort(), 5);
            await new Promise((resolve) => {
              signal?.addEventListener('abort', resolve, { once: true });
            });
            throw new DOMException('已取消', 'AbortError');
          }
          return { text: '[]' };
        },
      },
    },
  );
  await assert.rejects(report, (error: Error) => error.name === 'AbortError');
  assert.equal(appended, false, '取消的审查不应写入案卷');
});

test('案卷写入失败不阻断审查', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      model: { provider: 'fake', model: 'fake-1' },
      history: {
        async append() {
          throw new Error('磁盘已满');
        },
        async recent() {
          throw new Error('读取失败');
        },
      },
    },
    { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
  );
  assert.ok(report.findings.length >= 1);
});

test('未知透镜 id 直接报错而非静默扩大范围', async () => {
  await assert.rejects(
    runReview(
      {
        scope: { kind: 'diff', diffText: SAMPLE_DIFF },
        lenses: ['securty'],
        model: { provider: 'fake', model: 'fake-1' },
      },
      { llm: fakeLlm({}) },
    ),
    /未知透镜 id/,
  );
});

test('部分未知透镜 id 同样报错（不静默丢弃）', async () => {
  await assert.rejects(
    runReview(
      {
        scope: { kind: 'diff', diffText: SAMPLE_DIFF },
        lenses: ['correctness', 'securty'],
        model: { provider: 'fake', model: 'fake-1' },
      },
      { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
    ),
    (error: Error) => error.message.startsWith('未知透镜 id：securty'),
  );
});

/** 深度扫描：任何属性值不得为 undefined（dsh lossless-JSON 边界的运行时不变量）。 */
function assertNoUndefined(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoUndefined(v, `${path}.${key}`);
    }
    return;
  }
  assert.notEqual(value, undefined, `属性 ${path} 的值为 undefined（lossless-JSON 边界拒绝）`);
}

test('报告全程不含 undefined 属性值（lossless-JSON 兼容）', async () => {
  // 无历史、无深度复核、含 mixed 与纯透镜发现的默认路径
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness', 'security'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE, '安全性': SECURITY_RESPONSE }) },
  );
  assertNoUndefined(report);
  // 带历史与深度复核的路径
  const withHistory = await runReview(
    {
      scope: { kind: 'diff', diffText: SAMPLE_DIFF },
      lenses: ['correctness'],
      deep: true,
      model: { provider: 'fake', model: 'fake-1' },
      history: {
        async append() {},
        async recent() {
          return [];
        },
      },
    },
    {
      llm: {
        async complete({ system }) {
          if (system?.includes('正确性')) return { text: CORRECTNESS_RESPONSE };
          return { text: '{"confirmations":[{"index":0}],"refutations":[]}' };
        },
      },
    },
  );
  assertNoUndefined(withHistory);
});

test('空 diff 产生空报告而非崩溃', async () => {
  const report = await runReview(
    {
      scope: { kind: 'diff', diffText: '' },
      lenses: ['correctness', 'security', 'maintainability'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    { llm: fakeLlm({ '正确性': CORRECTNESS_RESPONSE }) },
  );
  assert.equal(report.findings.length, 0);
  assert.equal(report.stats.files, 0);
  assert.equal(report.parseFailures.length, 0);
  assert.equal(report.lenses.length, 3);
});

test('paths 模式：读取文件并审查，缺失文件被记录', async () => {
  const { writeFileSync } = await import('node:fs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gavel-eng-'));
  const file = join(dir, 'svc.ts');
  writeFileSync(file, 'export const apiKey = "sk-zzz999888";\n', 'utf8');
  const report = await runReview(
    {
      scope: { kind: 'paths', paths: [file, join(dir, 'missing.ts')] },
      lenses: ['security'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    { llm: fakeLlm({ '安全性': '[]' }) },
  );
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0]!.path.endsWith('missing.ts'));
  assert.ok(report.stats.tripwireHits >= 1);
  rmSync(dir, { recursive: true, force: true });
});

test('纯删除文件的 diff 不进入审查视图', async () => {
  const report = await runReview(
    {
      scope: {
        kind: 'diff',
        diffText: `diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-print("bye")
-print("again")
`,
      },
      lenses: ['correctness', 'security'],
      model: { provider: 'fake', model: 'fake-1' },
    },
    { llm: fakeLlm({ '正确性': '[]', '安全性': '[]' }) },
  );
  assert.equal(report.scope.files.length, 0, '删除文件不应出现在审查文件清单');
  assert.equal(report.stats.files, 0);
  assert.equal(report.stats.addedLines, 0);
  assert.equal(report.findings.length, 0);
});
