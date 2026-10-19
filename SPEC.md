# SPEC —— dsh-conversation-recorder 契约（中文说明，字段名英文）

> 本文档是唯一契约来源。字段表区块由 `<!-- CONTRACT-FIELDS-BEGIN -->` 与 `<!-- CONTRACT-FIELDS-END -->` 标注（含这两行本身），代码与测试都对着它写。**契约裁决（2026-09-10）**：轮次表去掉摘要列、轮次 frontmatter 去掉占位数组、时间统一 UTC、新增配置节、§6 fork 基点改用「本进程首个 turn/start」；契约语义须连贯无窟窿，禁止为让测试通过而改其他契约条款。

## 1. 目标

DSH 会话目前只活在压缩日志（zstd）里，不可读不可引。本插件把**新会话**实时记录成 `_conversations` 下的可读 Markdown 链（索引 + 轮次），让其他对话能读它当记忆。历史会话不回填；已存在的 `_conversations` 文件不删改。

记录的正确性优先于一切：工具调用要真出清单行、重启/续跑不能丢链（不许出现负序号或缺号）、元数据不许被空值抹掉。

## 2. 布局

布局表达式：`_conversations/<工作区文件夹>/<sessionId>/{index.md,turns/NNNN.md}`（第一段 `_conversations` 指 **root**——默认即 `$DSH_HOME/_conversations`，可由 `Config.root` 改到别处，见下）。

```
<root>/                        # 记录根（默认为内置统一位置 <$DSH_HOME>/_conversations，见 §8）
└── <工作区文件夹>/              # 分区第一级：由会话 cwd 按下方规则转义（cwd 缺失 → 未分组）
    └── <sessionId>/            # 会话目录，目录名 = session.id
        ├── index.md            # 会话索引：frontmatter 元数据 + 轮次表
        └── turns/
            └── NNNN.md         # 轮次正文，NNNN 为 4 位零填充序号（0001.md, 0002.md …）
```

**根解析顺序**（工作区名只由会话 cwd 决定，根只有一个来源）：

1. 插件 `Config` 的 `root`（命名空间 `dsh-conversation-recorder`，见 §8）——宿主按 schema 解析后的当前值，用户改了就生效；
2. 空串视为「没有值」；
3. 内置默认 `$DSH_HOME/_conversations`（`$DSH_HOME` 由 `resolveDshHome()` 语义解析：显式值 → `$DSH_HOME` → `~/.dsh`）——兜底。

0.2.1 起宿主只保留 `Config` 一层：旧的「设置服务 + 装配配置 + 内置默认」三层已合并成 `config.root.get()`，故落点**不再跟随各会话自己的 cwd**。

工作区文件夹名（`workspaceDir(cwd)`，纯函数、同 cwd 恒定同名）逐条规则：

1. `cwd` 缺失或为空串 → `未分组`。
2. 去掉全部 `:`，再把每个 `\` 与每个 `/` 换成 `-`（两种分隔符等价，避免正斜杠 cwd 在 Windows 上被当成再下一级目录）。
3. 每个**连续非 ASCII 段**保留可读形式，紧跟该段每个 UTF-16 码元的 `~XXXX`（4 位大写十六进制）。
4. 其余 `*` `?` `"` `<` `>` `|` `#` `^` `[` `]` `~` 各转义成 `~XXXX`。
5. 上述处理后为空 → `未分组`。

例：`D:\我的笔记` → `D-我的笔记~6211~7684~7B14~8BB0`；`D:\示例` → `D-示例~793A~4F8B`。

- 会话目录恒为 `<root>/<工作区文件夹>/<sessionId>`；`root` 的解析见 §8。
- **登记时机 = 首次见到该会话的事件**（`session/created` 或任一 `session/event`，见 §7/§8）：`session/event` 遇到未登记会话时先按同一段逻辑建档（子代理过滤、不安全 id 兜底、resume 自愈都在 `onSessionCreated` 内部），再处理本次事件。故 `session/created` 那次广播没到达（插件停用重开 / 进程重启）的会话，只要再更新一次轮次就被自动接上并续号。
- fork 子会话继承父会话 cwd ⇒ 父子在同一工作区文件夹，故 §4.1 的跨会话 `prev`（`../<父会话id>/turns/NNNN.md`）不受分区影响。
- 首个内容轮次（turn/end 落盘）时才建目录与 index.md（避免仅打开会话就产生空壳）；`started` 仍取 header.createdAt；`session/title` 事件补写 title——但**只在会话目录已存在时**补写，元数据事件（`session/title`/`request/context`）自己不建目录、不写 index（`emptyIndex` 设置见 §8，默认 false 即本行为）。
- 会话 id 作为目录名必须安全：空串、`.`、`..` 一律**拒绝记录**该会话（stderr 记一行警告），只允许 `[A-Za-z0-9._-]`（其余字符替换为 `_`）。
- 轮次在 `turn/end` 时原子落盘：先写 `<同名>.tmp` 再 rename 为 `NNNN.md`；随后 index.md 轮次表重建。
- 同序号的轮次文件已存在时**拒绝覆写**（跳过，文件不变）。
- 写盘失败（mkdir / 写文件 / rename / 写 index 任一）→ stderr 记一行警告，**丢弃该轮、不重试**，不抛给 DSH 事件总线。
- 子代理会话（`session.header.origin === 'subagent'`）**不记录**。
- `session/disposed` 时回收该会话的内存记录（不删文件）。

## 3. index.md

### 3.1 frontmatter（字段：title/session/started/model/turns/fork_from）

```markdown
---
title: ${title 初值空串，session/title 事件后更新}
session: ${session.id}
started: ${ISO8601 UTC 创建时间（header.createdAt）}
model: ${model 名；无 request/context 事件时留空}
turns: ${已落盘轮次总数}
fork_from: ${父会话 session.id；无 fork 时留空}
---

（本文件位于 `<工作区文件夹>/<sessionId>/index.md`；`session` 字段仍是会话 id，工作区文件夹名从路径读出。）
```

重启/续跑自愈：`session/created`（或首次见到该会话的事件）若发现自身 index.md 已存在，则从 index.md 读回 `title`/`model`/`fork_from`，并扫 `turns/` 下 `NNNN.md` 的**序号集合**回填 `seqs`（`turns` = 该集合的元素个数）——**不得**用空值覆盖已有元数据，也**不得**把「洞」当成「没有这一号」（序号规则见 §6）。

### 3.2 正文：轮次表（三列，无摘要列）

```markdown
| seq | time | kind |
| --- | ---- | ---- |
| 0001 | ${ISO8601 UTC} | completed |
```

- `seq` = 轮次序号（同 turns/ 文件名数字，4 位零填充；= 磁盘最大序号 + 1，负数/零**不落盘**，见 §6）。
- `time` = `turn/end` 时间 ISO8601 **UTC**（`…Z`）。
- `kind` = `turn/end` 的 reason.kind（completed/aborted/blocked/error/max-tokens/interrupted 等）。
- 轮次表由磁盘现状重建（扫 `turns/NNNN.md` 读回 time/kind），不额外维护内存表。

## 4. turns/NNNN.md（轮次正文）

### 4.1 frontmatter（字段：session/seq/time/kind/prev）

```markdown
---
session: ${session.id}
seq: ${NNNN 序号}
time: ${turn/end ISO8601 UTC}
kind: ${reason.kind}
prev: ${叙事链上一轮路径；首轮且有 fork 基点时用它，否则留空}
---
```

- `prev` = 叙事链上一轮**文件路径**。同会话 = `turns/NNNN-1.md`；跨会话（fork 首轮且 fork 基点 `base > 0`）= `../<父会话id>/turns/NNNN.md`（NNNN = base 四位填充）。无上一轮时留空。
- `links` / `files` 两个占位字段**已按 2026-09-10 裁决删除**，不再写入，也不得出现在任何新产物里。

### 4.2 正文

- 用户消息行：`## user` 小节下逐条正文文本（多文本块合并）。收录的 `source.kind` 只有两种：
  - `user`（人直接输入）；
  - `agent-message`（另一个 agent 发来的消息）。
  其他来源（`plugin` / `skill-catalog` / `skill-invocation` / `subagent-*` 等）不进本小节。两类都没有可读文本时写占位行 `（无用户文本）`。
- agent 回答：`## assistant` 小节逐条正文文本（`assistant/message` 的 `message.content[].text` 合并；空 content 只载 usage 的消息跳过；无回答时写「（无正文）」）。
- 工具调用 = 清单行，格式固定为：
  `- [${callId前12位}] ${工具名} ${参数预览} → 结果${X}行 [error:${code}]`
  - `callId` 取自 `tool/result` 消息的 `message.toolCallId ?? message.source.callId`（0.2.1 的 v4 载荷把 callId 放在消息顶层，旧的 `source.callId` 仍在，作为兼容位；两者与 `tool/call` 的 `callId` 配对）。
  - X = 结果文本行数；结果文本取 `tool/result` 消息 `message.content` 里的 `type === 'text'` 块（v4 已去掉旧的 `type:'tool-result'` 包壳）。文本为空记 0 行。
  - `${code}` 取自 `tool/result` 的 `error?.code`；无 error 时整段 `[error:…]` 省略。
  - `参数预览` = `arguments` 的 JSON 字符串前 `toolArgsPreview` 个字符（设置项，默认 40，取值域 0–200；默认行为即此前契约里的「前40字符」）。
  - 只有 `tool/call` 没有配对 `tool/result` 的调用不出行（避免捏造结果）。
  - 一轮里 user / assistant / 工具清单**三样全空**时不落盘（不建目录、不写文件、不占序号）。
- 若本轮还引入会话引用（`source.kind === 'session-reference'`），记一行：`- 引用会话 ${引用sessionId}`。

## 5. 契约字段表区块

<!-- CONTRACT-FIELDS-BEGIN -->

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| title | string | index 标题；初值空串，session/title 后更新；resume 时从 index 读回 |
| 工作区文件夹 | string | 会话目录的上一级目录名，由会话 cwd 按 §2 规则转义；cwd 缺失或为空时为 `未分组` |
| session | string | 会话 id（目录名，位于工作区文件夹下） |
| started | string | 会话创建 ISO8601 UTC（header.createdAt） |
| model | string | 模型名；无 request/context 事件时留空；resume 时从 index 读回 |
| turns | number | 已落盘轮次总数（turns/ 下 NNNN.md **文件个数**；resume 时按磁盘回填）。注意与 `seq` 的关系：磁盘上有洞时 `turns`（个数）**小于**最大 `seq`，这是正常的（洞只跳过不回填，见 §6） |
| fork_from | string | 父会话 id；无 fork 留空 |
| seq | string(4位) | 轮次序号 = 该会话磁盘上已存在的最大序号 + 1（见 §6）；负数或零拒绝落盘 |
| time | string | 轮次结束 ISO8601 UTC |
| kind | string | turn/end reason.kind |
| prev | string | 叙事链上一轮文件路径；跨会话 fork 首轮 ../<父id>/turns/NNNN.md |
| callId | string(前12) | 工具清单行内联引用 [callId前12]，取自 tool/result 消息的 `toolCallId ?? source.callId` |
| 工具清单行 | — | `- [callId前12] 工具名 参数前 toolArgsPreview 字（默认 40，0–200）→ 结果X行 [error:code]` |

<!-- CONTRACT-FIELDS-END -->

## 6. 轮次序号与 fork

**序号规则（总则）**：`seq` = **该会话在磁盘上已存在的最大序号 + 1**（`turns/` 下 `NNNN.md` 文件名里的数字，落盘前现扫现读；实现在 `src/seq.ts` 的纯函数 `nextSeq()`）。普通会话与 fork 会话一律适用。

- **为什么不是「已落盘轮次数 + 1」**（0.2.3 及以前的规则）：个数口径下，磁盘上「有洞」的序号集合（例如 `0001,0002,0004`——`0003` 那一轮因写盘失败/被删/外部放置而缺席）会被算成个数 3 ⇒ 下一轮写 `0003`，即**回填洞、顶替本该属于别的材料的序号**；而当序号的最大值远大于个数时（历史产物的旧命名、手工放置的文件），后续序号会长期低于磁盘最大序号，与「已有文件不覆写」这条死规矩互锁，「被跳过的轮次」就**永久卡死**后续记录。取磁盘最大序号 + 1 后序号**只增不减**：洞被跳过（不回填、不顶替），链继续向前。
- **与旧规则的关系**：磁盘上**无洞**时二者**逐字等价**（`max = 个数` ⇒ `max + 1 = 个数 + 1`）。落盘前先把磁盘上的实际序号集合读进来，故新规则同样是「磁盘是权威」的写法。
- `seq <= 0` 一律**拒绝写入**（stderr 一行警告，本轮丢弃，文件不落盘）。
- 入参里 `<= 0` 的序号（历史产物的旧命名等）**不参与取最大值**，否则会把最大值拉低、让序号倒退。
- 本规则**不做停摆检测**：不判断「磁盘上的序号是否已经用尽」，只按上述规则给出结果。

- `turn/end` 落盘失败（mkdir / 写 / rename 任一）或同序号文件已存在而拒写时，该轮**不产出文件**；下一个序号仍按磁盘最大序号 + 1 算，于是链只会向前（**不**回填被跳过的那一号）。
- **普通会话**：`seq` 从 1 起，每成功落盘一轮 +1（磁盘无洞时与旧规则完全一致）。
- **fork 会话**（判定与基点，按 2026-09-10 裁决）：
  - `header.parentSession` 存在（真 seed fork：父日志被 seed 进子会话）→ `fork_from` = 父会话 id，**基点 `F`** = 本进程首个 `turn/start` 的 turn − 1（即绝对 turn 计数与子自身已落盘轮次之间的偏移）。
  - 仅首轮出现 `session-reference` 引用（@引用路径，`header.parentSession` 不存在）→ `fork_from` = 被引用会话 id，`F = 0`。
  - **基点只用于首轮 `prev`**：`prev = ../<父会话id>/turns/NNNN.md`（NNNN = `F` 四位填充；`F = 0` 或普通会话首轮留空）。`seq` **不由** `turn − F` 算出，而是按总则取「磁盘上已存在的最大序号 + 1」，因此「重启续跑」「漏掉一轮后继续」两种情况都仍只会向前写。
  - `F` **不使用**父会话 index.md 的轮次数：父索引的轮次数不等于真实 fork 点（父在 fork 之后可能继续增长），据此计算会产生 0 或负 seq。
- `turn/end` 事件的 `turn` 是绝对叙事序号，**只**参与 `F` 的推定与首轮 `prev` 的寻址，不参与 `seq` 计算。
- **换 root 之后序号从头算**：`seqs` 只从**当前 root 下的那个会话目录**扫（§8「认已有记录靠磁盘」），root 改到空目录后，该会话在**新根**下的下一个序号是 1（旧根下的记录不迁不删，也不参与序号计算）。

## 7. 事件订阅（实现依赖）

- `ctx.on('session/created', session => …)`：**登记时机是「首次见到该会话的事件」**——本处理器在收到该广播时建档（`session.header.origin !== 'subagent'` 才建；只记内存 record，首个内容轮次 turn/end 落盘时才建目录/index；同时按 §3.1 做 resume 自愈回填；`header.parentSession` 只登记 fork_from，基点等首个 `turn/start` 再定），`session/event` 在遇到仍未登记的会话时会自己补走同一段建档逻辑（见 §8），故这次广播没到达也能接上。三个监听器都包 `try/catch`：异常只记 stderr，不抛回宿主事件总线。
- `ctx.on('session/event', (session, event) => …)`：先判 `enabled`（§8，关闭则整轮不落盘）；再处理 `turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`、`request/context`（填 model），以及插件扩展事件 `session/title`（填 title；该事件不在 `@deepseek-ai/dsh-session` 的核心事件联合里，按扩展类型识别）。载荷就是完整 `Session`（`header` 与 `session/created` 时同一个对象）。
- `ctx.on('session/disposed', session => …)`：回收内存记录。
- 设置接线：`ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`——本插件自带设置分区（§8），不让宿主自动生成设置页。
- 载荷规格依据 `@deepseek-ai/dsh-session` 的 `SessionEventMap`（types.d.ts）与 `@deepseek-ai/dsh-llm` 的消息类型（`ToolResultMessage.toolCallId` / `source.callId` / `content` 的 text 块），并用 0.2.1 的真实 v4 会话日志逐字核对。

## 8. 配置

0.2.1 的配置模型：插件在 `src/settings.ts` `export const Config = z.object({...})`，五个字段全部
`.volatile()`（宿主把它们暴露成稳定引用 `config.<field>.get()`；每次读取都是当前值）。命名空间 =
profile 里的插件条目 id `dsh-conversation-recorder`。

| 字段 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| `enabled` | boolean | `true` | **总开关**。`false` 时立即停止产出新文件：任何事件都不再落盘/补写 index，进行中的那一轮**整轮丢弃、不落半份**；**不删任何已有内容**（已落盘的 `index.md`/`turns/` 一字不动） |
| `root` | string | 内置统一路径 `<$DSH_HOME>/_conversations`（`$DSH_HOME` 经 `resolveDshHome()`） | 记录根目录；空串视为未设置（回退内置默认根）。支持开头 `~` 展开 |
| `recordSubagents` | boolean | `false` | `true` 时子代理会话（`session.header.origin === 'subagent'`）也记录；默认不记 |
| `toolArgsPreview` | number | `40` | 工具清单行里参数预览的字符数，取值 0–200（越界由 schema 拒绝） |
| `emptyIndex` | boolean | `false` | `true` 时允许元数据事件（`session/title`/`request/context`）自行建目录并写 index；默认 false ⇒ 只有首个内容轮次落盘才建目录 |

- **改完即时生效，不用重启**：引擎每个事件从 `config.<field>.get()` 重读，不缓存；被设置覆盖的五个点分别是总开关（`enabled`，最先判断）、落点解析（`root`）、子代理过滤（`recordSubagents`）、参数截断长度（`toolArgsPreview`）、建目录时机（`emptyIndex`）。
- **schema 是真 schemastery**：`Config = z.object({…})`（运行时 import `@deepseek-ai/schemastery`）。宿主用它渲染/校验设置页；五个字段都 `.volatile()`，故 `config.enabled.get()` 等是稳定引用。`toolArgsPreview` 越界由 schema 直接拒绝（不再静默钳制）。
- **不再有设置注册 API**：0.2.1 删掉了旧的设置注册模型；插件不再注册命名空间、也不再 `watch()`。`apply()` 只做 `ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`，告诉宿主本插件自带设置分区。
- **设置页分区**：客户端半边 `inject: ['slots', 'configForms']`，用 `ctx.configForms.get('dsh-conversation-recorder')` 取 `ConfigForm`：
  - 读：`form.getSnapshot()`（`status/value/revision/writable`）+ `form.subscribe()`；
  - 写：逐字段 `await form.set(field, value)`（revision、失败回读、写入排队都由宿主服务负责；客户端不再自己解信封、也不再自增版本号）。
  - 控件全部来自宿主自带的 `@deepseek-ai/dsh-client-ui-primitives`（`Input`/`Button`）+ DSH 设计变量；**不传 `style` 给官方 `Input`**（会打进内层内容框）。读/写失败显示在分区里。
- 未挂载设置服务时（`ctx.settings` 不存在）插件照常工作：直接使用宿主解析出的 `Config` 默认值。
- root 只此一层：工作区文件夹仍按 `<root>/<workspaceDir(会话 cwd)>/<sessionId>/` 分一级（§2），工作区名只由会话 cwd 决定；`cwd` 缺失时落 `未分组`。

```ts
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  root: z.string().default(defaultRoot()).volatile(),
  recordSubagents: z.boolean().default(false).volatile(),
  toolArgsPreview: z.natural().min(0).max(200).default(40).volatile(),
  emptyIndex: z.boolean().default(false).volatile(),
})
```

## 9. 不做什么（边界）

- 不改 DSH 本体；不写 `_conversations` 之外的目录；不删改已存在的 `_conversations` 文件。
- 不加运行时依赖；不给 index 加语义摘要列；不做图谱页。
- **运行时依赖白名单恰好两项**：`@deepseek-ai/dsh-home-paths`（内置默认根**真调**其 `resolveDshHome()`）与 `@deepseek-ai/schemastery`（设置 schema 的**真构造器**）。二者由 DSH 随装提供、按 `peerDependencies` 声明（**不进 `dependencies`**），允许在 `src/**` **运行时 import**；除此之外的任何裸包名（含其它 `@deepseek-ai/*`）一律不许——这条红线由 `tests/run.ts` 的 R9 守住。
  - 二者同时按**钉版本**列在 `devDependencies`：`peerDependencies` 只声明「由宿主提供」的消费契约，而开发与 CI 需要用它们解析类型/跑测试（宿主进程里由 profile 的 `node_modules` 解析，CI 里没有 DSH 安装树）。这是**开发期解析**，不是插件运行时的依赖——`dependencies` 仍然为空。

## 10. 产物文档（记录根下的 README.md / AGENTS.md）

**触发时机**：某个会话的**首个内容轮次**（`turn/end`）成功落盘之后（`src/docs.ts` 的 `ensureRootDocs(root)`）。
只发元数据事件不触发（与「懒建目录」同一口径）。

**只缺则写**（这是本节的死规矩）：

1. 文件**已存在** ⇒ **一个字节都不动**——包括**没有生成标记的手写文件**；那种情况只往 stderr 提示一行
   （`<path> 已存在且没有生成标记（手写文件），保持原样不动`），**绝不改写、绝不覆盖**。
2. 文件**缺失** ⇒ 写出带生成标记的版本；写失败（mkdir/写/rename 任一）只往 stderr 记一行，**不抛**，
   不影响记录主流程。

**内容契约**：

| 文件 | 面向 | 首行 | 体积 |
| ---- | ---- | ---- | ---- |
| `<root>/README.md` | 人 | `<!-- generated by dsh-conversation-recorder -->` | 不限（实测远小于 2KB） |
| `<root>/AGENTS.md` | 读这份记录的 AI agent | 同上 | **≤ 2048 字节**（写前按 UTF-8 字节数检查，超限即拒写并记 stderr） |

- 两份文档都必须说明：目录布局（`<工作区文件夹>/<sessionId>/{index.md,turns/NNNN.md}`）、怎么读
  （先 `index.md` 的 frontmatter 与三列轮次表，再按 `prev` 顺链读 `turns/`）、以及**只读红线**
  （不要手改/删除本目录下的文件）。
- `enabled: false` 时**一个字节都不写**（总开关语义，见 §8；引擎在事件入口就返回，走不到触发点）。
- 幂等：同一 root 上重复触发不改变任何已存在文件（`ensureRootDocs` 返回本次**新写出**的文件名列表）。
- 同 root 下的会话共用这两份文档（不是每个会话一份）。

## 11. 发布一致性门禁

发布前必须全部干净（CI 里按 node 22 与 node 24 各跑一遍）：

| 命令 | 判据 |
| ---- | ---- |
| `pnpm typecheck` | `tsc -p tsconfig.json` → **0 error**（`skipLibCheck: false`，类型真过） |
| `pnpm typecheck:client` | `tsc -p tsconfig.client.json` → **0 error** |
| `node tests/run.ts` | 通过 ≥ 64、失败 0、跳过 0（测试沙箱在系统临时目录，可用 `DSH_RECORDER_TEST_TMP` 覆盖） |
| `node tests/spec-selfcheck.ts` | 绿（exit 0） |
| `node tests/probe-real-settings.ts` / `node tests/probe-client-bundle.ts` | 各 exit 0 |
| `pnpm verify` | `pnpm build` 后 `git diff --exit-code -- lib` **干净** ⇒ `lib/` 与 `src/` 一致 |
| `pnpm verify:privacy` | 仓库内无机器特定路径（盘符用户目录 / POSIX 用户家目录）、无真实会话 id |

- **`lib/` 必须与 `src/` 一致**：`lib/` 是安装时真正加载的产物（`package.json` 的 `main`/`exports`）。
  改过 `src/**` 就必须重跑 `pnpm build` 并把 `lib/` 一起提交；`pnpm verify` 就是这条的机器判据
  （它先构建再比对 `git diff`，任何「改了源码没重构建」都会红）。
- **隐私门禁**（`scripts/check-privacy.ts`）扫的是**仓库里所有入库文本文件**，排除版本库元数据、
  依赖目录、测试沙箱、二进制与脚本自身。三类禁串见该脚本头部注释。
  - **判据里不许写死用户名**（2026-09-16 修订）：按「系统用户目录前缀」形态判（盘符用户目录、
    POSIX 用户家目录），与具体是谁无关。旧实现把本机用户名当字面量，换机器/换用户名即失效却仍
    输出「绿」——把「没检出」误读成「没有」是这条门禁最危险的失效模式。
  - **判据只收带真实路径的形态**，对散文与示例零误报：波浪号家目录简写（`~/`，§2/§8 规定的
    正规表达，本身不含用户名）与用户目录环境变量名都**不查**。会长期假红的规则最终会被绕过，
    那比少一条规则更危险。
- 构建中间目录 `.client-build-tmp/` 不入库；测试沙箱默认建在系统临时目录（不落在仓库里），不依赖 `tests/.tmp/`。
