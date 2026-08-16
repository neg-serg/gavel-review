/**
 * 审查透镜注册表：每个透镜是一个独立的“攻击式审查视角”，
 * 携带人设、可落地的检查点清单与攻击指引。
 *
 * 默认内置三个透镜：正确性（拆解员）、安全性（渗透员）、可维护性（清道夫）。
 * 使用者可在配置中选择启用的透镜子集。
 */

import { LENS_IDS, type LensId } from './types.ts';

/** 检查点条目。 */
export interface ChecklistItem {
  id: string;
  text: string;
}

/** 透镜定义。 */
export interface LensDef {
  id: LensId;
  /** 中文名称。 */
  label: string;
  /** 攻击者代号。 */
  codename: string;
  /** 人设（一句话）。 */
  motto: string;
  /** 攻击指引正文。 */
  probeFocus: string;
  /** 检查点清单。 */
  checklist: ChecklistItem[];
}

/** 正确性透镜：边界破坏者。 */
const CORRECTNESS: LensDef = {
  id: 'correctness',
  label: '正确性',
  codename: '拆解员',
  motto: '你的任务不是确认代码能用，而是找到它必然翻车的方式。',
  probeFocus:
    '逐项对照检查点清单，重点攻击：输入边界、状态转换、错误路径与并发时序。' +
    '对每一处可疑点，先在心里构造一个能让它出错的输入或时序，只有确实成立才报告。' +
    '忽略风格问题；只关心“在真实运行中会导致错误结果、崩溃或数据损坏”的问题。',
  checklist: [
    { id: 'C01', text: '空值与未初始化：变量、返回值、解构结果可能为 null/undefined/None 的路径' },
    { id: 'C02', text: '边界与越界：off-by-one、空集合、单元素、满容量、长度截断、分页游标' },
    { id: 'C03', text: '类型与隐式转换：弱类型比较、字符串/数字混用、NaN/Infinity、浮点与货币精度' },
    { id: 'C04', text: '状态机与分支：遗漏的分支、else 吞掉的情形、不可达逻辑、默认值错误' },
    { id: 'C05', text: '并发与竞态：共享可变状态、先读后写、锁序、未 await 的异步、回调重入' },
    { id: 'C06', text: '错误路径：异常被吞、出错后继续执行、部分成功无回滚、失败状态未置位' },
    { id: 'C07', text: '资源生命周期：句柄/连接/定时器/订阅泄漏、重复释放、释放顺序' },
    { id: 'C08', text: '语义边界：时区、编码、换行符、大小写、区域设置、舍入规则' },
    { id: 'C09', text: '幂等与重入：重复调用副作用、重试语义、信号/回调重入、重复提交' },
    { id: 'C10', text: '契约一致性：调用方与被调方假设（参数顺序、返回约定、错误码、协议版本）' },
  ],
};

/** 安全性透镜：渗透者。 */
const SECURITY: LensDef = {
  id: 'security',
  label: '安全性',
  codename: '渗透员',
  motto: '假设一切输入都来自攻击者，找到能让系统被攻破的缝隙。',
  probeFocus:
    '逐项对照检查点清单，以攻击者视角寻找可利用的缝隙。' +
    '对每一项，评估“是否真的能到达攻击面、是否真的可控、影响是什么”，避免泛泛而谈。' +
    '不要报告纯理论风险；报告必须有具体的攻击路径或至少可信的触发条件。',
  checklist: [
    { id: 'S01', text: '注入：SQL/命令/模板/XPath/日志注入、shell 拼接、路径拼接' },
    { id: 'S02', text: '敏感信息：硬编码凭据、日志打印秘密、错误信息泄露内部结构、响应头泄露' },
    { id: 'S03', text: '认证与授权：缺失校验、水平/垂直越权、会话固定、令牌过期缺失' },
    { id: 'S04', text: '数据完整性与序列化：不可信反序列化、签名/校验缺失、类型混淆、降级明文' },
    { id: 'S05', text: '资源与拒绝服务：无界输入、无限重试、昂贵操作未限流、灾难性正则' },
    { id: 'S06', text: '传输与存储加密：明文传输、弱算法、固定 IV/盐、TLS 校验被关闭' },
    { id: 'S07', text: '供应链与依赖：依赖无版本锁定、可疑安装钩子、锁文件漂移' },
    { id: 'S08', text: '客户端侧安全：XSS、innerHTML 注入、CSP 缺失、开放重定向' },
    { id: 'S09', text: '权限边界与沙箱：越权文件访问、路径穿越、符号链接、临时文件竞态（TOCTOU）' },
    { id: 'S10', text: '安全默认值：不安全默认配置、调试开关上线、宽松 CORS/ACL、默认口令' },
  ],
};

/** 可维护性透镜：清道夫。 */
const MAINTAINABILITY: LensDef = {
  id: 'maintainability',
  label: '可维护性',
  codename: '清道夫',
  motto: '找那些会让下一位接手的人陷入绝望、让线上事故难以定位的写法。',
  probeFocus:
    '逐项对照检查点清单，从“三个月后的维护者”视角审查。' +
    '每条建议应给出具体的重构方向，而非空泛口号；可维护性问题通常不致命，但会累积成技术债。' +
    '只报告明显可操作的项，不要为每行代码都挑毛病。',
  checklist: [
    { id: 'M01', text: '复杂度：嵌套过深、超大函数、分支爆炸、循环内副作用' },
    { id: 'M02', text: '重复与复制粘贴：相似逻辑多处出现、可提取未提取、平行实现漂移' },
    { id: 'M03', text: '命名与可读性：误导性命名、缩写、命名与行为不符、注释与实现不一致' },
    { id: 'M04', text: '死代码与残留：未使用参数/导入/分支、注释掉的代码、调试输出、临时代码' },
    { id: 'M05', text: '耦合与分层：全局状态、隐藏依赖、越层调用、魔法值散落、god object' },
    { id: 'M06', text: '错误处理一致性：裸 catch、吞错、错误类型混乱、成功/失败返回混合' },
    { id: 'M07', text: '测试脆弱性：断言不足、依赖时序/网络、快照过大、测试复制实现细节而非验证行为' },
    { id: 'M08', text: '弃用与兼容：使用已弃用 API、破坏性变更未标记、迁移残留、双实现并存' },
    { id: 'M09', text: '可观测性：关键路径无日志/指标、错误无上下文、故障难以定位' },
    { id: 'M10', text: '可配置性：硬编码配置、环境差异未抽象、feature flag 缺失、隐式依赖环境' },
  ],
};

/** 透镜注册表：id → 定义。 */
export const LENS_REGISTRY: Record<LensId, LensDef> = {
  correctness: CORRECTNESS,
  security: SECURITY,
  maintainability: MAINTAINABILITY,
};

/** 列出全部透镜 id。 */
export function listLenses(): LensId[] {
  return [...LENS_IDS];
}

/** 取透镜定义；未知 id 返回 null。 */
export function getLens(id: string): LensDef | null {
  return LENS_REGISTRY[id as LensId] ?? null;
}

/**
 * 校验透镜 id 列表，过滤未知项。
 * - 未提供或为空 → 全部透镜；
 * - 提供但全部未知 → 空列表（由调用方决定如何报错，避免静默扩大范围）。
 */
export function resolveLenses(ids?: string[]): LensId[] {
  if (!ids || ids.length === 0) return listLenses();
  const seen = new Set<LensId>();
  for (const id of ids) {
    const lens = getLens(id);
    if (lens) seen.add(lens.id);
  }
  return [...seen];
}
