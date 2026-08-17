[English](README.md)

# gavel-review

对抗式多视角代码审查插件。多个独立审查视角（透镜）并行地对代码改动发起攻击式审查——每个视角只关心自己那一类问题，彼此不干扰；随后仲裁层把跨视角的发现合并去重、按严重度分级，输出带证据与修复建议的报告。全程只读，不修改任何代码。

插件自带确定性静态哨兵（无需模型的规则扫描）、抑制规则（防止同类问题反复上报）与审查历史（增量对照已知问题），并同时提供两种入口：

- **dsh（DeepSeek Harness）插件入口**：注册 `gavel_review` 工具，模型在会话中直接调用；
- **独立 CLI 入口**：本地命令行运行，兼容任何 OpenAI Chat Completions 协议的模型服务。

零第三方运行时依赖（核心引擎与 CLI 仅使用 Node 内置能力）。

---

## 设计思路

单一审查者容易被自己的视角带偏：写代码的人看不到自己的盲区，通用审查又常常把风格问题与真正的缺陷混在一起。gavel 的做法是**把「破坏」拆成多个专业方向，并行攻击，再合并战果**：

- 每个透镜带一套**可落地的检查点清单**（如「空值与未初始化」「注入」「复杂度」），发现必须对应到具体检查点，报告可直接追溯到清单条目；
- 透镜之间并行扇出，互不等待（可独立配置启用哪些透镜）；
- 静态哨兵先于模型用确定性规则兜底，保证即使模型失败也有产出；
- 仲裁层按「文件 + 行号邻近 + 标题词元重叠」聚类跨透镜发现，多个视角命中同一问题会获得**佐证加成**，严重度可能升一级；
- 严重度是**确定性计算**（影响 × 2 + 置信度 + 佐证），同一输入永远得到同一结论；
- 可选**深度复核**阶段：对候选问题逐条做挑战式再验证，被驳回的问题降级为「观察」而不是删除——决策过程保持透明。

## 审查流水线

```
输入（diff 文本 / 文件路径）
   │
   ▼
① 摄取 collect ──── 解析统一 diff 或读取文件，建立行映射
   │
   ▼
② 静态哨兵 tripwire ── 确定性正则规则（硬编码凭据、危险调用、残留调试……）
   │
   ▼
③ 透镜探测 probe ──── 正确性 / 安全性 / 可维护性 并行攻击（LLM 调用）
   │
   ▼
④ 深度复核 deep（可选）── 对候选问题挑战式再验证（串行）
   │
   ▼
⑤ 仲裁合并 merge ──── 跨透镜聚类、去重、指纹、严重度定级
   │
   ▼
⑥ 抑制过滤 suppress ── 命中抑制规则的问题归档不再上报
   │
   ▼
⑦ 案卷记录 docket ──── 追加历史、标记已知问题（增量审查）
   │
   ▼
报告（Markdown / JSON）
```

## 目录结构

```
adversarial-review/
├── package.json          # 包清单；dsh.bundle.patch 指向接入补丁
├── cordis.patch.yml      # dsh 接入补丁（装载插件行 + 默认配置）
├── bin/gavel.mjs         # CLI 启动器
├── src/
│   ├── index.ts          # 公共入口（库 API + dsh 插件模块导出）
│   ├── cli.ts            # 独立 CLI（review / history / rules）
│   ├── core/
│   │   ├── types.ts      # 领域模型
│   │   ├── engine.ts     # 编排引擎（流水线主控）
│   │   ├── diff.ts       # 统一 diff 解析器
│   │   ├── tripwire.ts   # 静态哨兵规则引擎
│   │   ├── lenses.ts     # 透镜注册表与检查点清单
│   │   ├── merge.ts      # 跨视角合并、聚类、指纹
│   │   ├── severity.ts   # 严重度定级（确定性）
│   │   ├── suppress.ts   # 抑制规则
│   │   ├── docket.ts     # 审查历史（JSONL）
│   │   └── report.ts     # Markdown / JSON 报告渲染
│   ├── llm/              # 模型客户端（接口 + HTTP 实现）
│   └── dsh/plugin.ts     # dsh 适配：Cordis 插件 + 工具注册
├── test/                 # node:test 测试套件（80 项）
└── examples/             # 示例 diff、规则文件
```

---

## 在 DSH 中安装

```bash
dsh plugin --profile demo add github:JohnXu22786/adversarial-review
```

以上命令安装已发布的插件及其 bundle 补丁（详细手动步骤见下文「dsh（DeepSeek Harness）接入」）。插件会注册 `gavel_review` 工具，模型即可在会话中直接调用。

## 独立 CLI 使用

要求 Node.js >= 20.19（源码直跑需 >= 23.6，见下文）。无需安装任何依赖即可使用构建产物：

```bash
# 构建（首次使用前）
npm install
npm run build

# 审查一个 diff 文件
node bin/gavel.mjs review --diff examples/sample.diff \
  --api-key $GAVEL_API_KEY --model deepseek-chat

# 审查最近一次提交
node bin/gavel.mjs review --base HEAD~1

# 审查指定文件（整文件模式）
node bin/gavel.mjs review --path src/order.js --path src/notify.js

# 组合选项：深度复核 + 生成抑制规则 + 输出报告文件 + CI 门禁
node bin/gavel.mjs review --diff p.patch --deep --emit-rules \
  --out report.md --json-out report.json --fail-on required

# 查看案卷与规则
node bin/gavel.mjs history --stats
node bin/gavel.mjs rules --list
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--diff <path\|->` | 统一 diff 文本文件（`-` 读 stdin），与 `--base`、`--path` 互斥 |
| `--base <ref>` | 运行 `git diff --unified=8 <ref>`（如 `HEAD~1`） |
| `--path <p>` | 整文件审查，可重复 |
| `--lens <a,b>` | 透镜子集：`correctness,security,maintainability`；含无效 id 时报错退出 |
| `--deep` | 启用深度复核（挑战式再验证） |
| `--emit-rules` | 为「必须修复」及以上问题生成抑制规则 |
| `--rules <path>` | 规则文件（默认 `<history-dir>/rules.json`） |
| `--no-history` | 关闭案卷与历史对照 |
| `--history-dir <d>` | 案卷目录（默认 `.gavel/`） |
| `--out / --json-out` | Markdown / JSON 报告输出路径 |
| `--fail-on <level>` | 存在达到该级别的问题时退出码为 2（CI 门禁） |
| `--model / --base-url / --api-key` | 模型路由；环境变量 `GAVEL_MODEL` / `GAVEL_BASE_URL` / `GAVEL_API_KEY`（或 `DEEPSEEK_API_KEY`） |

未构建产物时 CLI 自动回退为直接执行 `src/` 下的 TypeScript 源码（Node >= 23.6 内置类型擦除）。

## dsh（DeepSeek Harness）接入

dsh 采用「一切皆插件」架构：插件即 npm 包，通过 `package.json` 的 `dsh.bundle.patch` 字段声明接入补丁；补丁向 Cordis 配置行列表插入插件行；插件在 `apply(ctx, config)` 中以可逆效果注册能力。本插件的 dsh 接入点：

- **Manifest**：`package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
- **补丁**：`cordis.patch.yml`（插入 id 为 `gavel` 的插件行，含默认配置）
- **插件模块**：`src/dsh/plugin.ts`，具名导出 `name` / `inject` / `Config` / `apply`（与 dsh 工具插件同一装载约定：loader 取 `exports.default ?? exports`，再经 `ctx.registry.plugin()` 装配）
- **工具接口**：`apply()` 内 `ctx.tools.register(defineTool(...))` 注册 `gavel_review` 工具；模型在会话中即可调用，无需人类介入

### 安装步骤

```bash
# 1. 构建产物（lib/）
npm install && npm run build

# 2. 通过 dsh 的插件管理命令接入（等价于 pnpm 安装 + 自动识别 bundle 补丁）
dsh plugin --profile <你的 profile> add <本包路径或已发布的包名>

# 3.（可选）在 profile 的 cordis.patch.yml 中按 id 覆盖配置
# 覆盖示例：
# - id: gavel
#   name: 'gavel-review'
#   config:
#     deep: true
#     historyDir: .review
#     maxFindingsPerLens: 8
```

无插件管理命令时，也可手动在 profile 的 `cordis.patch.yml` 中加入上述行并把包加入依赖即可，机制相同。

### 工具接口：`gavel_review`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `diff` | string | 统一 diff 文本（建议 `git diff --unified=8` 输出）。与 `paths` 至少其一 |
| `paths` | string[] | 待审查文件路径列表（整文件审查） |
| `lenses` | string[] | 透镜子集（`correctness` / `security` / `maintainability`），默认全部 |
| `deep` | boolean | 是否深度复核；默认取部署配置 |
| `emitRules` | boolean | 为「必须修复」及以上问题生成抑制规则并写入规则文件 |

工具返回规范 JSON（`{ type: 'json' }` 输出声明），结构即报告本体；渲染给模型的是 Markdown 文本。模型侧描述已写明：只读、适合在合并/提交/重构后调用。

### 部署配置（`gavel` 行 config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `toolName` | `gavel_review` | 注册的工具名 |
| `provider` / `model` | 空 | 模型路由；留空跟随当前 agent，再兜底 `deepseek-official` / `deepseek-v4-flash` |
| `lenses` | 全部三个 | 启用的透镜 |
| `deep` | `false` | 是否默认深度复核 |
| `history` | `true` | 是否写案卷与历史对照 |
| `historyDir` | `.gavel` | 案卷与规则文件目录 |
| `maxCharsPerLens` | `24000` | 每个透镜的上下文上限（字符） |
| `maxFindingsPerLens` | `12` | 每个透镜最多报告条数 |
| `maxTokens` | `3000` | 单次透镜调用的输出上限（token） |

### 运行时行为

- 工具内部通过注入的 `ctx.llm` 流式接口发起透镜并行调用（Promise 扇出，单透镜失败不拖垮整体，失败会记录在报告的「解析失败」区）；`exec.signal` 全程透传，支持会话取消；
- 案卷与规则文件写在 `historyDir`（工作目录相对路径），写失败不阻断审查；
- 卸载插件即卸载工具注册（Cordis 可逆效果），无残留监听器。

> 版本说明：dsh 处于开发者预览阶段，API 可能演进。本插件按 rc 系列包的当前契约实现（`ctx.tools.register` + `defineTool`、`ctx.llm.stream`），若上游接口变更，只需调整 `src/dsh/plugin.ts` 一个文件。
>
> 依赖说明：包的根入口（`exports["."]`）同时承担 dsh 插件模块职责，静态导入 dsh 生态包；因此**以库方式 import 根入口时需要安装可选 peer 依赖**（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`）。独立 CLI（`bin/gavel.mjs`）与引擎子模块不经过根入口，保持零第三方运行时依赖。

---

## 严重度定级

分值 = 影响 × 2 + 置信度 + 佐证加成（多个独立视角同时命中 +1），上限 10：

| 分值 | 级别 | 含义 |
| --- | --- | --- |
| 9-10 | `blocker` 阻断发布 | 影响致命且置信度高，或获多视角佐证 |
| 7-8 | `required` 必须修复 | 上线前应处理 |
| 5-6 | `recommended` 建议修复 | 近期应处理 |
| 3-4 | `optional` 可选优化 | 视成本处理 |
| 0-2 | `informational` 观察 | 值得留意的信号 |

影响/置信度由各透镜在发现中自报（0-3），分值计算与分级完全确定性。深度复核驳回的问题固定降为 `informational` 并标注 `verified: refuted`。

## 静态哨兵（确定性规则）

内置 16 类规则，覆盖：硬编码凭据、私钥材料、动态代码执行、shell 拼接、SQL 拼接、空异常处理、调试残留、未完成标记、宽泛类型忽略、连接串内嵌口令、关闭 TLS 校验、破坏性命令、下载即执行、不可信反序列化、弱随机数安全场景、调试日志。规则按文件语言限定，命中参与合并与定级（可与透镜发现合成 `mixed` 来源）。

## 抑制规则

规则文件为 JSON（默认 `.gavel/rules.json`）：

```json
{
  "version": 1,
  "rules": [
    { "id": "r-001", "file": "src/**/*.js", "source": "any",
      "key": "console.log", "reason": "已知噪音", "createdAt": "2026-08-01T10:00:00Z" }
  ]
}
```

匹配：文件 glob（支持 `**` / `*` / `?`）+ 来源（`lens` / `tripwire` / `any`）+ 标题关键词（不区分大小写子串）。命中即从主报告中移入「被抑制的发现」区。`--emit-rules` 会为达到门槛的问题自动生成候选规则（人工可再编辑），CLI 提供 `rules --list / --add / --drop` 管理。

## 审查历史（案卷）

`.gavel/docket.jsonl`，追加式 JSONL，每条为一次审查摘要（时间、范围、指纹集合）。用途：

- 新报告的发现与历史指纹（文件 + 行号桶 + 标题词元）比对，命中者标记 `known` 并在报告中显示「与历史记录中的已知问题指纹一致」；
- `gavel history --stats` 查看运行次数、级别分布、问题高发文件。

## 开发与测试

```bash
npm test          # node:test 全量测试（80 项；测试直接运行源码，需 Node >= 23.6）
npm run typecheck # tsc --noEmit
npm run build     # 产出 lib/（npm install 时经 prepare 钩子自动执行）
```

代码约定：纯 ESM、TypeScript 可擦除语法（无 enum/装饰器），源文件内相对导入使用 `.ts` 后缀（`tsc` 构建时自动改写为 `.js`），因此测试与 CLI 可直接运行源码。

## 设计取舍与限制

- **只报告、不修改**：插件绝不触碰代码；修复建议只是文本。
- **透镜数是可配置的固定集**：默认三个视角覆盖正确性/安全性/可维护性，开发者可在 `lenses.ts` 中扩展自己的透镜与检查点清单。
- **哨兵是启发式**：正则规则会产生少量误报；命中携带各规则自带的影响度与置信度，走同一套确定性定级（如硬编码凭据可直接落在 `required`/`blocker`），且可被抑制规则压制。
- **深度复核增加成本**：每轮复核是一次额外的串行模型调用，默认关闭，按需开启。

---

## 许可

MIT — 见 [LICENSE](LICENSE)。
