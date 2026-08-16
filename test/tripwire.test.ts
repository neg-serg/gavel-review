/**
 * 静态哨兵测试：规则命中/不命中、语言限定、行号定位、防刷屏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanTripwire, TRIPWIRE_RULES } from '../src/core/tripwire.ts';

function scan(contents: Record<string, string>) {
  const files = Object.entries(contents).map(([path, text]) => {
    const lines = text.split('\n').map((line, i) => ({ line: i + 1, text: line }));
    return { path, lines };
  });
  return scanTripwire(files);
}

test('硬编码凭据命中且行号正确', () => {
  const hits = scan({
    'src/config.ts': 'line one\nconst apiKey = "sk-abc123456";\nline three',
  });
  const secret = hits.find((h) => h.ruleId === 'hardcoded-secret');
  assert.ok(secret, '应命中 hardcoded-secret');
  assert.equal(secret!.line, 2);
  assert.equal(secret!.file, 'src/config.ts');
  assert.equal(secret!.impact, 3);
});

test('私钥材料命中', () => {
  const hits = scan({ 'keys.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc' });
  assert.ok(hits.some((h) => h.ruleId === 'private-key-material'));
});

test('连接串内嵌口令命中', () => {
  const hits = scan({ 'db.js': 'const url = "postgres://admin:pass123@host:5432/db";' });
  assert.ok(hits.some((h) => h.ruleId === 'connection-url-cred'));
});

test('eval 只命中 JS 不命中无此语言限制的规则', () => {
  const hits = scan({ 'app.js': 'eval(userInput);', 'app.rb': 'eval(userInput)' });
  assert.equal(hits.filter((h) => h.ruleId === 'danger-eval').length, 2);
});

test('空 catch 多行模式命中', () => {
  const hits = scan({
    'x.ts': 'try {\n  risky();\n} catch (e) {\n\n}',
  });
  assert.ok(hits.some((h) => h.ruleId === 'empty-catch'));
});

test('python pass 空 except 命中', () => {
  const hits = scan({
    'x.py': 'try:\n    risky()\nexcept ValueError:\n    pass',
  });
  assert.ok(hits.some((h) => h.ruleId === 'empty-catch'));
});

test('有注释的空 catch 不命中（注释即文档）', () => {
  const hits = scan({
    'x.ts': 'try {\n  risky();\n} catch (e) { // 忽略已知噪音\n}',
  });
  assert.ok(!hits.some((h) => h.ruleId === 'empty-catch'));
});

test('TODO 标记命中', () => {
  const hits = scan({ 'a.py': 'def f():  # TODO: 优化此处\n    return 1' });
  assert.ok(hits.some((h) => h.ruleId === 'todo-marker'));
});

test('console.log 防刷屏（每文件上限）', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `console.log("x${i}");`).join('\n');
  const hits = scan({ 'a.js': lines });
  const logs = hits.filter((h) => h.ruleId === 'console-log');
  assert.equal(logs.length, 5);
});

test('sql 拼接命中', () => {
  const hits = scan({
    'q.py': 'query = f"SELECT * FROM users WHERE id = {uid}"',
  });
  assert.ok(hits.some((h) => h.ruleId === 'sql-concat'));
});

test('跨行间隙不产生伪命中（占位符隔离）', () => {
  // 两个 hunk 之间缺失内容用占位符填充，空 catch 模式不应跨越间隙
  const hits = scan({
    'x.ts': 'try {\n  risky();\n} catch (e) {',
  });
  // 仅传了 ctx+add 行且中间无 gap 时，可能命中；此测试验证 gap 场景：
  const gapped = scanTripwire([
    {
      path: 'y.ts',
      lines: [
        { line: 5, text: 'try {' },
        { line: 6, text: '  risky();' },
        { line: 7, text: '} catch (e) {' },
        { line: 42, text: '}' },
      ],
    },
  ]);
  assert.ok(!gapped.some((h) => h.ruleId === 'empty-catch'), 'gap 隔离应阻止跨间隙空 catch 命中');
});

test('pylint disable 清单命中（多规则逗号分隔）', () => {
  const hits = scan({
    'x.py': '# pylint: disable=W0611, W0612, C0301\nimport os',
  });
  const pylint = hits.find((h) => h.ruleId === 'broad-ignore');
  assert.ok(pylint, '应命中 broad-ignore');
  assert.equal(pylint!.line, 1);
});

test('规则表完整性：id 唯一、impact/confidence 在界内', () => {
  const ids = new Set<string>();
  for (const rule of TRIPWIRE_RULES) {
    assert.ok(!ids.has(rule.id), `规则 id 重复：${rule.id}`);
    ids.add(rule.id);
    assert.ok(rule.impact >= 0 && rule.impact <= 3);
    assert.ok(rule.confidence >= 0 && rule.confidence <= 3);
    assert.ok(rule.patterns.length > 0);
  }
});
