/**
 * 确定性静态哨兵：一组内置正则规则，在模型参与之前先用确定性手段
 * 抓取高风险模式（硬编码凭据、危险调用、残留调试等）。
 *
 * 规则命中即产生 TripwireHit，参与后续合并与定级。
 */

import type { TripwireHit } from './types.ts';
import { normalizePath } from './diff.ts';

/** 单条规则的匹配模式。 */
export interface TripwirePattern {
  /** 正则表达式源码。 */
  re: string;
  /** 正则修饰符（默认 'gi'）。 */
  flags?: string;
  /** 限定语言组（空 = 全部语言）。 */
  langs?: string[];
}

/** 一条哨兵规则。 */
export interface TripwireRule {
  id: string;
  name: string;
  category: string;
  /** 内置影响程度 0-3。 */
  impact: 0 | 1 | 2 | 3;
  /** 内置置信度 0-3。 */
  confidence: 0 | 1 | 2 | 3;
  /** 修复建议模板（支持 {file}、{line} 占位）。 */
  suggestion: string;
  /** 单条规则在同一文件的最大命中数（防止刷屏）。 */
  maxHitsPerFile?: number;
  patterns: TripwirePattern[];
}

/** 语言组 → 扩展名集合。 */
const LANGUAGE_EXT: Record<string, string[]> = {
  js: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
  python: ['.py', '.pyw'],
  java: ['.java'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb'],
  php: ['.php'],
  csharp: ['.cs'],
  sql: ['.sql'],
};

function languageOf(file: string): string {
  const lower = file.toLowerCase();
  for (const [lang, exts] of Object.entries(LANGUAGE_EXT)) {
    if (exts.some((ext) => lower.endsWith(ext))) return lang;
  }
  return 'generic';
}

/** 内置哨兵规则集。 */
export const TRIPWIRE_RULES: readonly TripwireRule[] = [
  {
    id: 'hardcoded-secret',
    name: '疑似硬编码凭据',
    category: '安全',
    impact: 3,
    confidence: 2,
    suggestion:
      '将凭据移入环境变量或密钥管理系统（如 .env + 配置注入），并轮换已泄露的密钥；仓库内残留的旧密钥需从历史中清除。',
    patterns: [
      {
        re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|token|access[_-]?key|private[_-]?key|credential|credential_key)\s*[:=]\s*['"][^'"]{6,}['"]/i.source,
      },
      { re: /\baws_secret_access_key\s*[:=]\s*['"][^'"]+['"]/i.source },
    ],
  },
  {
    id: 'private-key-material',
    name: '私钥材料入库',
    category: '安全',
    impact: 3,
    confidence: 3,
    suggestion: '私钥文件必须从仓库中移除（含 git 历史），改用密钥托管服务注入。',
    patterns: [{ re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i.source }],
  },
  {
    id: 'danger-eval',
    name: '动态代码执行',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '避免对不可信输入使用 eval/Function 类动态执行；确有需要时严格白名单校验并隔离上下文。',
    patterns: [
      { re: /\b(?:eval|Function)\s*\(/i.source, langs: ['js'] },
      { re: /\beval\s*\(/i.source, langs: ['python'] },
      { re: /\beval\s*\(/i.source, langs: ['ruby', 'php'] },
    ],
  },
  {
    id: 'shell-flag-on',
    name: 'shell 拼接执行',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '优先使用参数数组形式调用（无 shell 解释）；确需 shell 时对参数做白名单或转义校验。',
    patterns: [
      { re: /shell\s*[:=]\s*(?:true|True)/i.source, langs: ['js', 'python'] },
      { re: /(?:execSync?|spawn(?:Sync)?|execFile)\s*\([^)]*,\s*\{[^}]*shell\s*:\s*true/i.source, langs: ['js'] },
      { re: /os\.system\s*\(/i.source, langs: ['python'] },
      { re: /subprocess\.(?:call|run|Popen)\s*\([^)]*shell\s*=\s*True/i.source, langs: ['python'] },
    ],
  },
  {
    id: 'sql-concat',
    name: 'SQL 字符串拼接',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '改用参数化查询 / 预编译语句（?、%s、$1 等占位符），严禁将用户输入拼接进 SQL。',
    patterns: [
      {
        re: /['"`][^'"`]*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)[^'"`]*(?:\$\{|\+\s*['"`]|%s|\.format\s*\(|\{)/i.source,
      },
    ],
  },
  {
    id: 'empty-catch',
    name: '空异常处理',
    category: '正确性',
    impact: 2,
    confidence: 2,
    suggestion: '空 catch/except 会掩盖故障。至少记录错误并明确处置策略，或让异常沿调用链向上传播。',
    patterns: [
      { re: /\bcatch\s*(?:\([^)]*\))?\s*\{[\s]*\}/i.source, langs: ['js', 'java', 'csharp'] },
      { re: /except\b[^\n:]*:[^\n]*\n[ \t]*(?:#[^\n]*\n[ \t]*)?pass\b/i.source, langs: ['python'] },
    ],
  },
  {
    id: 'debugger-leftover',
    name: '调试断点残留',
    category: '正确性',
    impact: 1,
    confidence: 3,
    suggestion: '删除调试断点/调试器调用，避免在用户环境中断执行。',
    patterns: [
      { re: /\bdebugger\s*;?/i.source, langs: ['js'] },
      { re: /\b(?:pdb\.set_trace|breakpoint)\s*\(/i.source, langs: ['python'] },
    ],
  },
  {
    id: 'todo-marker',
    name: '未完成标记',
    category: '可维护性',
    impact: 0,
    confidence: 3,
    suggestion: '未完成项应建立独立任务跟踪并补充说明，避免随代码一起上线。',
    patterns: [{ re: /\b(?:TODO|FIXME|XXX|HACK)\b/i.source }],
  },
  {
    id: 'broad-ignore',
    name: '宽泛类型忽略',
    category: '可维护性',
    impact: 1,
    confidence: 2,
    suggestion: '将 @ts-ignore / @ts-nocheck / 无清单的 lint 禁用替换为具体到行、到规则的处理，并登记原因。',
    patterns: [
      { re: /@ts-(?:ignore|nocheck)\b/i.source, langs: ['js'] },
      { re: /pylint:\s*disable\s*=\s*[^,\]\n]+/i.source, flags: 'gim', langs: ['python'] },
    ],
  },
  {
    id: 'connection-url-cred',
    name: '连接串内嵌口令',
    category: '安全',
    impact: 3,
    confidence: 2,
    suggestion: '连接串中的用户名/口令应来自配置注入，禁止明文写在代码或默认配置中。',
    patterns: [{ re: /\b(?:postgres|postgresql|mysql|mongo(?:db)?|redis|amqp|jdbc|mongodb\+srv)[a-z+]*:\/\/[^:\/\s]+:[^@\s]+@/i.source }],
  },
  {
    id: 'insecure-tls',
    name: '关闭 TLS 校验',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '不要全局关闭证书校验；确需自签名场景应在测试环境且仅针对该主机，禁止带入生产。',
    patterns: [
      { re: /(?:rejectUnauthorized|verify_ssl|ssl_verify|VERIFY_PEER|VERIFY_NONE)\s*[:=]\s*(?:false|0|False)/i.source },
    ],
  },
  {
    id: 'destructive-command',
    name: '破坏性命令',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '删除类命令（rm -rf 通配、递归删除）应校验目标路径并明确设计意图，避免误删。',
    patterns: [
      { re: /\brm\s+-r[f]?\s+[^\s|;]*\*/i.source },
      { re: /shutil\.rmtree\s*\(/i.source, langs: ['python'] },
    ],
  },
  {
    id: 'pipe-to-shell',
    name: '下载即执行',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '禁止将远程内容直接管道给 shell；应下载后校验哈希/签名再执行。',
    patterns: [{ re: /\b(?:curl|wget)\b[^\n|]*(?:\||;)\s*(?:sudo\s+)?(?:ba)?sh\b/i.source }],
  },
  {
    id: 'unsafe-deserialize',
    name: '不可信反序列化',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '对不可信输入使用 pickle/yaml.load 等反序列化会执行任意代码；改用安全格式（JSON）或受限加载器。',
    patterns: [
      { re: /\b(?:pickle|marshal|cPickle)\.(?:loads?|dumps?)\s*\(/i.source, langs: ['python'] },
      { re: /\byaml\.load\s*\(/i.source, langs: ['python', 'ruby'] },
    ],
  },
  {
    id: 'weak-random-secret',
    name: '弱随机数用于安全场景',
    category: '安全',
    impact: 2,
    confidence: 2,
    suggestion: '口令/令牌/OTP 等安全场景必须使用密码学安全随机源（如 crypto.randomBytes / secrets.token_*）。',
    patterns: [
      { re: /(?:password|passwd|token|otp|secret|nonce|salt|key)\s*[:=]\s*[^;\n]*(?:Math\.random|random\.random\s*\()/i.source },
    ],
  },
  {
    id: 'console-log',
    name: '调试日志输出',
    category: '可维护性',
    impact: 0,
    confidence: 3,
    suggestion: '确认输出为有意保留的日志（考虑日志级别与脱敏）；无意的 console.log 应移除。',
    maxHitsPerFile: 5,
    patterns: [
      { re: /console\.(?:log|debug)\s*\(/i.source, langs: ['js'] },
      { re: /\bprint\s*\(/i.source, langs: ['python'] },
    ],
  },
];

/**
 * 对若干代码片段执行哨兵规则扫描。
 *
 * @param files - 文件名与行映射（行号 1 起）。diff 模式只传入 ctx+add 行，
 *   路径模式传入全部行；两者都要求行号与行内容一一对应。
 * @returns 排序后的命中列表。
 */
export function scanTripwire(
  files: Array<{ path: string; lines: Array<{ line: number; text: string }> }>,
): TripwireHit[] {
  const hits: TripwireHit[] = [];
  for (const file of files) {
    if (file.lines.length === 0) continue;
    const lang = languageOf(file.path);
    const pseudo = buildPseudoContent(file.lines);
    for (const rule of TRIPWIRE_RULES) {
      const applicable = rule.patterns.some((p) => !p.langs || p.langs.includes(lang));
      if (!applicable) continue;
      const limit = rule.maxHitsPerFile ?? 20;
      let count = 0;
      for (const pattern of rule.patterns) {
        if (count >= limit) break;
        if (pattern.langs && !pattern.langs.includes(lang)) continue;
        const regex = new RegExp(pattern.re, pattern.flags ?? 'gi');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(pseudo.content)) !== null) {
          if (count >= limit) break;
          const line = lineNumberAt(pseudo.content, match.index);
          const lineText = lineTextAt(pseudo.content, line);
          const snippet =
            lineText != null && !lineText.startsWith(FILL)
              ? lineText.slice(0, 120)
              : match[0].slice(0, 120);
          hits.push({
            ruleId: rule.id,
            ruleName: rule.name,
            category: rule.category,
            file: normalizePath(file.path),
            line,
            snippet,
            impact: rule.impact,
            confidence: rule.confidence,
            suggestion: rule.suggestion,
          });
          count++;
          if (match[0].length === 0) regex.lastIndex++; // 防零宽死循环
        }
      }
    }
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return hits;
}

/**
 * 行间占位符：保证伪内容的行号与真实行号一致，同时阻止多行规则
 * 跨过“未提供内容的行间隙”误匹配（占位符是非空白字符，不落入任何规则词法）。
 */
const FILL = '\u00A7';

/** 将行映射拼成“行号守恒”的伪内容：相邻行号缺失处用占位行补齐。 */
function buildPseudoContent(lines: Array<{ line: number; text: string }>): { content: string } {
  const sorted = [...lines].sort((a, b) => a.line - b.line);
  const parts: string[] = [];
  let prev = sorted[0]!.line - 1;
  for (const entry of sorted) {
    while (prev + 1 < entry.line) {
      parts.push(FILL);
      prev++;
    }
    parts.push(entry.text);
    prev = entry.line;
  }
  return { content: parts.join('\n') };
}

/** 计算字符偏移所在的行号（1 起）。 */
function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** 取指定行号的文本（1 起），越界返回 null。 */
function lineTextAt(content: string, line: number): string | null {
  let current = 1;
  for (let i = 0; i <= content.length; i++) {
    if (current === line) {
      const end = content.indexOf('\n', i);
      return content.slice(i, end === -1 ? undefined : end);
    }
    if (content.charCodeAt(i) === 10) {
      current++;
    }
  }
  return null;
}
