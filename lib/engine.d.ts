/**
 * dsh-conversation-recorder —— 事件引擎。
 *
 * 把 DSH 会话事件（session/created、session/event、session/disposed）组装成
 * `_conversations/<工作区文件夹>/<sessionId>/{index.md,turns/NNNN.md}` 的可读链。
 * 工作区文件夹名由会话 cwd 按 SPEC §2 规则算出（paths.workspaceDir）。与 cordis 解耦的
 * 纯逻辑：测试直接用合成事件驱动本引擎（不 mock 被测对象）；ctx 接线在文件末尾 apply()。
 *
 * 运行时依赖：本文件仅 node 内置 + 同插件相对模块；@deepseek-ai 只用 `import type`（编译期擦除）。
 * 全仓库唯一放行的两个裸包名（`schemastery`/`dsh-home-paths`）在 `settings.ts`，见 SPEC §9。
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { RecorderConfig } from './settings.js';
/** 会话对象里本引擎真正用到的部分（测试用合成对象驱动，不要求完整 Session）。 */
export interface SessionLike {
    readonly id: string;
    readonly header?: {
        readonly origin?: 'subagent';
        readonly parentSession?: string;
        readonly cwd?: string;
        readonly createdAt?: number;
    };
}
/**
 * 记录引擎。五个设置由 `Config` 的 `.volatile()` 字段提供（`config.<field>.get()`，
 * 每个事件重读，不缓存；设置页写入后立刻生效，见 SPEC §8）。
 */
export declare class RecorderEngine {
    /** 宿主传进来的 Config 实例（五个字段都是稳定引用）。 */
    private readonly config;
    private readonly sessions;
    /**
     * 本进程见过的会话 header（来自 `session/created`）。只用于「后续事件载荷没带 header」时补档：
     * 丢了 cwd 就丢了工作区文件夹 → 认不出磁盘上的已有记录。见 `onSessionEvent`。
     */
    private readonly headers;
    /** 已 `session/disposed` 的会话 id：headerless 的后续事件不得靠补档把它们重新建档。 */
    private readonly disposed;
    constructor(config?: RecorderConfig);
    /** 当前设置快照（每次读都重算，改完即时生效）。 */
    private current;
    /** 记录根：Config 的 root → 内置 `<$DSH_HOME>/_conversations`。 */
    private recorderRoot;
    /**
     * 会话目录重解析：设置里的 root 改了（live）后，后续轮次立刻落到新根下。
     * 只在真的变了时改动 record，避免每轮都做无谓的字符串比较。
     */
    private refreshDir;
    private warn;
    /**
     * session/created：默认 `header.origin === 'subagent'` 不建档（`recordSubagents` 设置打开才记）。
     *
     * - 懒建：只存内存 record，不建目录、不写 index（首个内容轮次 turn/end 才建）；
     * - `header.parentSession`（真 seed fork）→ 登记 fork_from，基点等首个 turn/start 再定；
     * - resume 自愈：index.md 已存在时从 index + turns/ 回填 turns/title/model，不用空值覆盖。
     */
    onSessionCreated(session: SessionLike): void;
    /**
     * resume 自愈：从自身 index.md 读回 title/model/fork_from，并按 turns/ 下
     * `NNNN.md` 的实际序号集合回填 `seqs`/`turns`（磁盘是权威）。读取失败只记 stderr，
     * 不影响后续记录。
     *
     * 序号集合（不是个数）是必需的：被跳过的轮次会在磁盘上留下洞，个数口径认不出洞，
     * 会让后续序号去顶替已有轮次（见 `src/seq.ts`）。
     */
    private restoreFromDisk;
    /** session/disposed：会话离开 store，回收内存记录（文件不动）。 */
    onSessionDisposed(session: {
        readonly id: string;
    }): void;
    /**
     * session/event 主入口：**首次见到该会话的事件就懒建档**（登记时机 = 首个事件，不是 `session/created`）。
     *
     * 为什么（2026-09-15 实测事故）：插件只认 `session/created` 那一次广播，插件被停用重开或进程重启后，
     * 正在跑的会话再也接不上，之后每一轮都被静默丢弃（实测丢过一整轮）。改成懒建档后，只要该会话
     * 再更新一次轮次就会被自动接上：`onSessionCreated` 内部的 `restoreFromDisk` 会从磁盘
     * `index.md` + `turns/` 读回 title/model/已落盘轮次数，于是续号接着 0001 之后的序号走，不重开。
     *
     * 子代理过滤与不安全 id 兜底**都在 `onSessionCreated` 内部**（不在这里加判断）：被过滤的会话
     * 建不了 record，下面 `rec === undefined` 直接返回，故子代理默认仍不落盘。
     *
     * `header` 缺失时的兜底（不改变「首次见到即建档」这条口径）：真宿主 `session/event` 的载荷就是
     * 完整 `Session`（`header` 与 `session/created` 时是同一个对象），所以正常路径本就有 header；
     * 但引擎不依赖这一点——只用 `{ id }` 也能靠本进程 `session/created` 见过的 header 补档。
     * **丢了 cwd 就丢了工作区文件夹**，会认不到磁盘上的已有记录（从 0001 重开），故补档是必要的；
     * 而「纯 `{ id }`、连 `session/created` 都没见过」的会话只能拒收（无处安放，SPEC §2 布局要求）。
     */
    onSessionEvent(session: SessionLike, event: SessionEvent): void;
    private handleEvent;
    private onTurnStart;
    private discardBuffers;
    /**
     * user/message：`## user` 只收 human（kind=user）与另一个 agent 发来的消息（kind=agent-message）；
     * `session-reference`（@引用）只用来登记 fork_from/引用行，不写进正文。
     */
    private onUserMessage;
    private onToolCall;
    /**
     * tool/result：callId 取 `message.toolCallId ?? message.source.callId`（0.2.1 的 v4
     * 载荷把 callId 放在消息顶层，旧载荷在 source 里），结果文本直接取消息 content 的
     * text 块（v4 去掉了旧的 `type:'tool-result'` 包壳），错误码取 `error?.code`。
     * 没有配对 tool/call 的结果不出行（不捏造）；结构异常（无 callId）直接跳过。
     */
    private onToolResult;
    /**
     * 懒建：只在需要落盘时确保 `<dir>/turns` 存在；失败记 stderr 并返回 false（调用方丢弃该轮）。
     */
    private ensureDir;
    /**
     * turn/end：原子写 `turns/NNNN.md`（.tmp → rename），随后重建 index 轮次表。
     *
     * `seq` = **磁盘上已存在的最大序号 + 1**（SPEC §6，实现在 `src/seq.ts`）——不用绝对 turn 数算，
     * 故重启续跑、fork、被跳过的轮次（写盘失败/被删/外部放置）之后都仍只会**向前**走：
     * 洞被跳过、绝不回填顶替已有轮次（磁盘无洞时与「已落盘轮次数 + 1」逐字等价）。
     * `turn` 只参与 fork 基点（首轮 `prev`）。
     * 写盘失败记 stderr 并丢弃本轮（不重试），该轮不计入序号集合，下一轮仍从同一个 seq 起。
     */
    private onTurnEnd;
    /**
     * 叙事链上一轮路径：同会话里**磁盘上小于本轮 seq 的最大序号**那一轮；
     * 当前面一轮都没有（首轮，含「洞在链头」）且 fork 基点 > 0 时，跨会话指父目录。
     *
     * 为什么不按 `seq - 1` 猜：新规则下「被跳过的轮次」会让最大序号与轮次个数脱钩，
     * `seq - 1` 可能正好是一个**不存在**的洞（会写出死链），而按磁盘现状取
     * 「更小的最大序号」永远指向真实存在的上一轮。
     *
     * 父会话与子会话同 cwd ⇒ 同一个工作区文件夹，故 `../<父id>/` 仍然成立（分区不影响本规则）。
     */
    private prevPath;
    /**
     * 把磁盘上的实际序号集合读进 `rec.seqs`（SPEC §6：序号规则的权威输入）。
     *
     * **每轮结束前都读一次**（磁盘是权威）：于是「被跳过的轮次」（写盘失败留下的洞、
     * 外部删掉的文件）不会让序号回退——旧规则按个数算，洞会让序号被顶替，洞大到
     * 「最大序号 ≫ 个数」时后续记录会被「拒绝覆写」永久卡死（0.2.3 的故障）。
     * 会话目录还不存在时不动内存状态（懒建：首个轮次落盘前没有磁盘可言）。
     * `turns/` 读失败（非 ENOENT）时保留内存现状并记 stderr，不把读失败当空会话。
     */
    private syncTurnSeqsFromDisk;
    /**
     * 重建 index.md（frontmatter + 三列轮次表；轮次表按磁盘现状重建）。
     *
     * 建目录时机（SPEC §2/§8）：本函数**默认不建目录**——只有会话目录已经在（即已有轮次落盘）
     * 才重建 index，避免「只发元数据事件」落出空壳目录。`emptyIndex: true` 时允许它自己建。
     */
    private writeIndex;
}
/** 本插件用到的 ctx 面（不引入 cordis 运行时/类型依赖，结构兼容即可）。 */
export interface PluginCtx {
    on(event: 'session/created', listener: (session: Session) => void): unknown;
    on(event: 'session/disposed', listener: (session: Session) => void): unknown;
    on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): unknown;
    /** 运行时注入 settings 服务（0.2.1 的配置模型：插件自己 export Config）。 */
    inject(names: readonly string[], callback: (child: PluginChildCtx) => void): unknown;
    /** 插件 fiber：`settings.configure` 的 owner（与宿主官方插件同一写法）。 */
    readonly fiber: unknown;
}
/** `ctx.inject(['settings'], child => …)` 里的子上下文。 */
export interface PluginChildCtx {
    effect(callback: () => () => void): unknown;
    settings: {
        configure(presentation: {
            readonly auto?: boolean;
        }, owner?: unknown): () => void;
    };
}
/**
 * 接线薄壳：把 ctx 事件接到引擎上；`config` 是宿主按 `Config` 解析出的实例
 * （五个字段都是 `.volatile()` 稳定引用，引擎每次事件重读，设置改了立刻生效）。
 *
 * `settings.configure({ auto: false }, ctx.fiber)`：本插件自带设置分区（客户端
 * `configForms`），告诉宿主不要再自动生成一张设置页。
 */
export declare function apply(ctx: PluginCtx, config?: RecorderConfig): void;
