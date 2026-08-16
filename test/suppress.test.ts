/**
 * 抑制规则测试：glob 匹配、关键词匹配、加载/保存、生成与过滤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  globToRegExp,
  ruleMatches,
  loadRules,
  saveRules,
  generateRules,
  applyRules,
} from '../src/core/suppress.ts';
import type { MergedFinding, SuppressionRule } from '../src/core/types.ts';

function finding(partial: Partial<MergedFinding>): MergedFinding {
  return {
    fingerprint: 'fp',
    severity: 'required',
    score: 7,
    impact: 2,
    confidence: 2,
    source: 'lens',
    lenses: ['security'],
    checkpoint: 'S01',
    title: 'SQL 注入风险',
    file: 'src/api/login.ts',
    line: 12,
    detail: '',
    evidence: [],
    suggestion: '',
    known: false,
    ...partial,
  };
}

test('globToRegExp：* 与 ** 与 ?', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/api/login.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c/d.ts'));
  assert.ok(!globToRegExp('src/**/*.ts').test('src/api/login.js'));
  assert.ok(globToRegExp('*.ts').test('index.ts'));
  assert.ok(!globToRegExp('*.ts').test('dir/index.ts'));
  assert.ok(globToRegExp('a?.ts').test('a1.ts'));
  assert.ok(globToRegExp('a?.ts').test('ab.ts'));
  assert.ok(!globToRegExp('a?.ts').test('a.ts'));
  assert.ok(!globToRegExp('a?.ts').test('abc.ts'));
  assert.ok(globToRegExp('**/package.json').test('package.json'));
  assert.ok(globToRegExp('**/package.json').test('node_modules/x/package.json'));
  assert.ok(globToRegExp('**').test('src/api/login.ts'));
});

test('ruleMatches：文件 + 来源 + 关键词', () => {
  const rule: SuppressionRule = {
    id: 'r-001',
    file: 'src/**/*.ts',
    source: 'lens',
    key: 'sql 注入',
    reason: '测试',
    createdAt: '2026-01-01T00:00:00Z',
  };
  assert.ok(ruleMatches(rule, finding({ source: 'lens', file: 'src/api/login.ts' })));
  // 来源不符
  assert.ok(!ruleMatches(rule, finding({ source: 'tripwire', file: 'src/api/login.ts' })));
  // 文件不符
  assert.ok(!ruleMatches(rule, finding({ file: 'src/api/login.py' })));
  // 关键词不符（大小写不敏感）
  const other = finding({ title: '数组越界访问' });
  assert.ok(!ruleMatches(rule, other));
  const upper = finding({ title: 'SQL 注入风险！' });
  assert.ok(ruleMatches(rule, upper));
  // any 来源可匹配全部
  assert.ok(ruleMatches({ ...rule, source: 'any' }, finding({ source: 'tripwire' })));
});

test('loadRules：文件缺失与损坏均返回空', () => {
  assert.deepEqual(loadRules(join(tmpdir(), 'no-such-file-rules.json')), []);
  const dir = mkdtempSync(join(tmpdir(), 'gavel-'));
  const bad = join(dir, 'rules.json');
  saveRules(bad, []);
  assert.deepEqual(loadRules(bad), []);
  rmSync(dir, { recursive: true, force: true });
});

test('saveRules 写出 version 1 格式并可读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gavel-'));
  const file = join(dir, 'rules.json');
  const rules: SuppressionRule[] = [
    { id: 'r-001', file: '**/*.ts', source: 'any', key: '注入', reason: 't', createdAt: 'x' },
  ];
  saveRules(file, rules);
  assert.deepEqual(loadRules(file), rules);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('generateRules：仅对达到门槛级别的问题生成，且去重', () => {
  const findings = [
    finding({ title: 'SQL 注入风险', file: 'src/a.ts', severity: 'blocker' }),
    finding({ title: 'SQL 注入风险', file: 'src/a.ts', severity: 'blocker' }), // 重复
    finding({ title: '轻微日志问题', file: 'src/b.ts', severity: 'informational' }),
    finding({ title: '函数过长', file: 'src/c.ts', severity: 'required' }),
  ];
  const rules = generateRules(findings, 'required', []);
  assert.equal(rules.length, 2);
  assert.ok(rules.some((r) => r.key.toLowerCase().includes('sql')));
  assert.ok(rules.some((r) => r.key.includes('函数过长')));
  // 与已有规则不重复生成
  const again = generateRules(findings, 'required', rules);
  assert.equal(again.length, 0);
});

test('ruleMatches：mixed 来源可被 lens 与 tripwire 规则命中', () => {
  const lensRule: SuppressionRule = {
    id: 'r-l',
    file: '**',
    source: 'lens',
    key: '密钥',
    reason: 't',
    createdAt: 'x',
  };
  const tripwireRule: SuppressionRule = { ...lensRule, id: 'r-t', source: 'tripwire' };
  const mixed = finding({ source: 'mixed', title: '硬编码 API 密钥' });
  assert.ok(ruleMatches(lensRule, mixed));
  assert.ok(ruleMatches(tripwireRule, mixed));
  assert.ok(ruleMatches(lensRule, finding({ source: 'lens', title: '硬编码 API 密钥' })));
  assert.ok(!ruleMatches(lensRule, finding({ source: 'tripwire', title: '硬编码 API 密钥' })));
});

test('文件作用域规则不抑制无文件定位的发现', () => {
  const scoped: SuppressionRule = {
    id: 'r-scoped',
    file: 'src/api/**',
    source: 'any',
    key: '注入',
    reason: 't',
    createdAt: 'x',
  };
  const universal: SuppressionRule = { ...scoped, id: 'r-univ', file: '**' };
  const noFile = finding({ file: null });
  assert.ok(!ruleMatches(scoped, noFile));
  assert.ok(ruleMatches(universal, noFile));
});

test('applyRules：命中即抑制并记录规则 id', () => {
  const rule: SuppressionRule = {
    id: 'r-001',
    file: '**',
    source: 'any',
    key: '注入',
    reason: 't',
    createdAt: 'x',
  };
  const kept = finding({ title: '数组越界' });
  const suppressed = finding({ title: 'SQL 注入风险' });
  const result = applyRules([kept, suppressed], [rule]);
  assert.deepEqual(result.kept.map((f) => f.title), ['数组越界']);
  assert.equal(result.suppressed.length, 1);
  assert.equal(result.suppressed[0]!.ruleId, 'r-001');
  // 空规则直接放行
  const none = applyRules([suppressed], []);
  assert.equal(none.kept.length, 1);
  assert.equal(none.suppressed.length, 0);
});
