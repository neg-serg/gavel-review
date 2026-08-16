/**
 * diff 解析器测试：多文件、多 hunk、新增/删除文件、行号与计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../src/core/diff.ts';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ const x = 1;
 const keep = true;
-const gone = false;
+const added = true;
+const added2 = 2;
 // comment
@@ -30,2 +32,2 @@
 function f() {
   return 1;
 }
`;

test('解析多文件多 hunk 的结构', () => {
  const parsed = parseDiff(SAMPLE);
  assert.equal(parsed.files.length, 1);
  const file = parsed.files[0]!;
  assert.equal(file.path, 'src/a.ts');
  assert.equal(file.oldPath, 'src/a.ts');
  assert.equal(file.isNew, false);
  assert.equal(file.isDeleted, false);
  assert.equal(file.hunks.length, 2);
  assert.equal(file.addedLines, 2);
  assert.equal(file.removedLines, 1);
});

test('hunk 行号逐行递增并区分类型', () => {
  const parsed = parseDiff(SAMPLE);
  const hunk = parsed.files[0]!.hunks[0]!;
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.oldStart, 10);
  const adds = hunk.lines.filter((l) => l.type === 'add');
  const dels = hunk.lines.filter((l) => l.type === 'del');
  const ctxs = hunk.lines.filter((l) => l.type === 'ctx');
  assert.equal(adds.length, 2);
  assert.equal(dels.length, 1);
  assert.equal(ctxs.length, 2);
  // 新文件行号：ctx(10), del(无), add(11), add(12), ctx(13)
  assert.deepEqual(
    hunk.lines.map((l) => l.newLine),
    [10, null, 11, 12, 13],
  );
  // 旧文件行号：ctx(10), del(11), add(无), add(无), ctx(12)
  assert.deepEqual(
    hunk.lines.map((l) => l.oldLine),
    [10, 11, null, null, 12],
  );
});

test('新增文件与删除文件', () => {
  const parsed = parseDiff(`diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+print("hello")
+print("world")
`);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.isNew, true);
  assert.equal(parsed.files[0]!.oldPath, null);

  const deleted = parseDiff(`diff --git a/old.py b/old.py
deleted file mode 100644
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-print("bye")
-print("again")
`);
  assert.equal(deleted.files.length, 1);
  assert.equal(deleted.files[0]!.isDeleted, true);
  assert.equal(deleted.files[0]!.path, 'old.py');
  assert.equal(deleted.files[0]!.removedLines, 2);
});

test('空输入与空改动', () => {
  assert.equal(parseDiff('').files.length, 0);
  assert.equal(parseDiff('no diff here\njust text\n').files.length, 0);
});

test('CRLF 归一化', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const parsed = parseDiff(crlf);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.addedLines, 2);
});

test('no newline 标记行被忽略', () => {
  const parsed = parseDiff(`${SAMPLE}\\ No newline at end of file\n`);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.addedLines, 2);
});

test('带引号的含空格路径被正确解析', () => {
  const parsed = parseDiff(`diff --git "a/src/foo bar.ts" "b/src/foo bar.ts"
--- "a/src/foo bar.ts"
+++ "b/src/foo bar.ts"
@@ -1 +1 @@
-old
+new
`);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0]!.path, 'src/foo bar.ts');
  assert.equal(parsed.files[0]!.oldPath, 'src/foo bar.ts');
});

test('末尾换行不产生幻影上下文行', () => {
  const parsed = parseDiff(`--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-old
+new
`);
  const hunk = parsed.files[0]!.hunks[0]!;
  assert.deepEqual(
    hunk.lines.map((l) => [l.type, l.text]),
    [
      ['del', 'old'],
      ['add', 'new'],
    ],
  );
});

test('跨文件 diff 正确分段', () => {
  const parsed = parseDiff(`${SAMPLE}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0]!.path, 'src/a.ts');
  assert.equal(parsed.files[1]!.path, 'src/b.ts');
});
