/**
 * CLI 参数解析测试：子命令分派、旗标取值/布尔、范围互斥、错误边界。
 * 解析失败通过 CliError 抛出（由 main 统一映射为退出码 1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliError, parseArgs } from '../src/cli.ts';

test('review 为默认子命令，正常解析取值旗标与布尔旗标', () => {
  const { command, options } = parseArgs([
    '--diff', 'p.patch',
    '--lens', 'correctness,security',
    '--deep', '--emit-rules', '--quiet',
    '--fail-on', 'required',
    '--max-tokens', '1500',
  ]);
  assert.equal(command, 'review');
  assert.equal(options.diff, 'p.patch');
  assert.deepEqual(options.lenses, ['correctness', 'security']);
  assert.equal(options.deep, true);
  assert.equal(options.emitRules, true);
  assert.equal(options.quiet, true);
  assert.equal(options.failOn, 'required');
  assert.equal(options.maxTokens, 1500);
});

test('--path 可重复出现', () => {
  const { options } = parseArgs(['--path', 'a.ts', '--path', 'b.ts']);
  assert.deepEqual(options.paths, ['a.ts', 'b.ts']);
});

test('--base、--diff、--path 互斥', () => {
  assert.throws(() => parseArgs(['--base', 'HEAD~1', '--path', 'a.ts']), CliError);
  assert.throws(() => parseArgs(['--diff', 'p.patch', '--base', 'HEAD~1']), CliError);
  assert.throws(() => parseArgs(['--path', 'a.ts', '--diff', 'p.patch']), CliError);
});

test('未知旗标与游离参数报错', () => {
  assert.throws(() => parseArgs(['--nope']), CliError);
  assert.throws(() => parseArgs(['--path', 'a.ts', 'stray']), CliError);
});

test('取值旗标缺值、重复与非法整数报错', () => {
  assert.throws(() => parseArgs(['--diff']), CliError);
  assert.throws(() => parseArgs(['--model', '--deep']), CliError);
  assert.throws(() => parseArgs(['--diff', 'a', '--diff', 'b']), CliError);
  assert.throws(() => parseArgs(['--max-tokens', '0']), CliError);
  assert.throws(() => parseArgs(['--max-chars', 'abc']), CliError);
});

test('--lens 空列表报错', () => {
  assert.throws(() => parseArgs(['--lens', '']), CliError);
});

test('--fail-on 非法级别报错', () => {
  assert.throws(() => parseArgs(['--fail-on', 'critical']), CliError);
});

test('history 子命令必须给出 --last 或 --stats', () => {
  assert.throws(() => parseArgs(['history']), CliError);
  const last = parseArgs(['history', '--last', '3']);
  assert.equal(last.command, 'history');
  assert.equal((last.options as unknown as { last: number }).last, 3);
  const stats = parseArgs(['history', '--stats']);
  assert.equal((stats.options as unknown as { stats: boolean }).stats, true);
});

test('rules 子命令要求 --list / --add / --drop 之一', () => {
  assert.throws(() => parseArgs(['rules']), CliError);
  // --add 与 --list 同时给出时 --add 优先（动作互斥由调用方取其一即可）
  const both = parseArgs(['rules', '--list', '--add', 'x', 'y']);
  assert.equal((both.options as unknown as { addKey: string }).addKey, 'x');
});

test('rules --add 拒绝空 key 或缺失 file', () => {
  assert.throws(() => parseArgs(['rules', '--add', '', 'src/a.ts']), CliError);
  assert.throws(() => parseArgs(['rules', '--add', '注入']), CliError);
  const ok = parseArgs(['rules', '--add', '注入', 'src/**']);
  assert.equal(ok.command, 'rules');
});

test('rules --drop 与 --list 可解析', () => {
  const drop = parseArgs(['rules', '--drop', 'r-001']);
  assert.equal((drop.options as unknown as { dropId: string }).dropId, 'r-001');
  const list = parseArgs(['rules', '--list']);
  assert.equal((list.options as unknown as { list: boolean }).list, true);
});

test('子命令词只在首位生效，不吞旗标值', () => {
  const parsed = parseArgs(['--diff', 'review']);
  assert.equal(parsed.command, 'review');
  assert.equal(parsed.options.diff, 'review');
});
