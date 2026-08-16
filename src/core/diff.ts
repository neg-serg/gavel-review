/**
 * 统一 diff（unified diff）解析器。
 *
 * 输入为 git 风格 `git diff` 输出（支持 --unified 任意上下文行数），
 * 解析出文件级与 hunk 级结构，并为每行标注新文件行号（供透镜与哨兵定位）。
 */

/** hunk 内的一行。 */
export interface HunkLine {
  /** 行类型：context / 新增 / 删除。 */
  type: 'ctx' | 'add' | 'del';
  /** 行内容（不含行首标记符）。 */
  text: string;
  /** 新文件行号（ctx 与 add 行有值，del 行为 null）。 */
  newLine: number | null;
  /** 旧文件行号（ctx 与 del 行有值，add 行为 null）。 */
  oldLine: number | null;
}

/** 一个 hunk（@@ 块）。 */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
  addedLines: number;
  removedLines: number;
}

/** 解析出的文件。 */
export interface ParsedFile {
  /** 新文件路径（删除文件为旧路径）。 */
  path: string;
  /** 旧文件路径；新增文件为 null。 */
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
  addedLines: number;
  removedLines: number;
}

/** 解析结果。 */
export interface ParsedDiff {
  files: ParsedFile[];
}

const HEADER_OLD = /^---\s+(.+)$/;
const HEADER_NEW = /^\+\+\+\s+(.+)$/;
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/** 去掉 git 路径前缀（a/、b/）与引号包裹，/dev/null 归为 null。 */
function cleanPath(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '/dev/null') return null;
  const unquoted = trimmed.replace(/^"(.*)"$/, '$1');
  return unquoted.replace(/^[ab]\//, '');
}

/**
 * 解析统一 diff 文本。
 * @param diffText - 原始 diff 文本（含或不含 `diff --git` 头均可）。
 * @returns 解析结果；空输入返回空文件列表。
 */
export function parseDiff(diffText: string): ParsedDiff {
  const files: ParsedFile[] = [];
  const normalized = diffText.replace(/\r\n/g, '\n');

  let current: ParsedFile | null = null;
  let currentHunk: Hunk | null = null;
  let newLine: number | null = null;
  let oldLine: number | null = null;

  for (const rawLine of normalized.split('\n')) {
    if (rawLine === '') continue; // 末尾换行产生的空元素
    // 文件头或文件分隔标记：结束上一个文件，开始新文件
    if (rawLine.startsWith('diff --git') || rawLine.startsWith('Index: ')) {
      if (current != null) files.push(current);
      current = null;
      currentHunk = null;
      continue;
    }
    // 无 git 头时，新的 `---` 也意味着上一个文件结束
    if (current != null && HEADER_OLD.test(rawLine)) {
      files.push(current);
      current = null;
      currentHunk = null;
    }
    if (current == null) {
      const oldMatch = HEADER_OLD.exec(rawLine);
      if (oldMatch) {
        current = {
          path: '',
          oldPath: cleanPath(oldMatch[1] ?? null),
          isNew: false,
          isDeleted: false,
          hunks: [],
          addedLines: 0,
          removedLines: 0,
        };
        continue;
      }
      continue;
    }
    const newMatch = HEADER_NEW.exec(rawLine);
    if (newMatch) {
      const newPath = cleanPath(newMatch[1] ?? null);
      if (newPath == null) {
        // 删除文件：保留旧路径，标记删除
        current.isDeleted = true;
        current.path = current.oldPath ?? '';
      } else {
        current.path = newPath;
        current.isNew = current.oldPath == null;
      }
      continue;
    }
    const hunkMatch = HUNK_HEADER.exec(rawLine);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      currentHunk = {
        oldStart: oldLine,
        oldCount: Number(hunkMatch[2] ?? '1'),
        newStart: newLine,
        newCount: Number(hunkMatch[4] ?? '1'),
        lines: [],
        addedLines: 0,
        removedLines: 0,
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk == null) continue; // index/相似度等杂行
    if (rawLine.startsWith('\\')) continue; // “No newline at end of file”

    const marker = rawLine.charAt(0);
    const text = rawLine.slice(1);
    let type: HunkLine['type'];
    let hunkNewLine: number | null = null;
    let hunkOldLine: number | null = null;
    if (marker === '+') {
      type = 'add';
      hunkNewLine = newLine;
      newLine = newLine == null ? null : newLine + 1;
      currentHunk.addedLines++;
      current.addedLines++;
    } else if (marker === '-') {
      type = 'del';
      hunkOldLine = oldLine;
      oldLine = oldLine == null ? null : oldLine + 1;
      currentHunk.removedLines++;
      current.removedLines++;
    } else {
      type = 'ctx';
      hunkNewLine = newLine;
      hunkOldLine = oldLine;
      newLine = newLine == null ? null : newLine + 1;
      oldLine = oldLine == null ? null : oldLine + 1;
    }
    currentHunk.lines.push({ type, text, newLine: hunkNewLine, oldLine: hunkOldLine });
  }

  // 收尾：提交最后一个文件
  if (current != null) files.push(current);

  // 丢弃解析失败的“残次文件”（既无路径也无 hunk）
  return { files: files.filter((f) => f.path !== '' || f.hunks.length > 0) };
}

/** 按文件路径归一化（用于跨透镜聚类时统一大小写与分隔符）。 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
