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

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { ensureRootDocs } from './docs.ts'
import { readIndexMeta, readTurnRows, renderIndex, renderTurn, scanTurnSeqs } from './format.ts'
import { isoFromEpochMs, isoNow, resolveRoot, safeSessionDir, seqFile, workspaceDir } from './paths.ts'
import { nextSeq } from './seq.ts'
import { Config, defaultRoot, settingsOf } from './settings.ts'
import type { RecorderConfig, RecorderSettings } from './settings.ts'

/** 一次工具调用的待配对信息（tool/call 记下，tool/result 取出成行）。 */
interface PendingTool {
  readonly name: string
  readonly argsPreview: string
}

/** 单会话记录状态。 */
interface SessionRec {
  readonly id: string
  /** 会话目录 `<root>/<工作区文件夹>/<sessionId>`（root 改了会在下次事件时重解析）。 */
  dir: string
  /** 记录根目录（`_conversations` 本身；会话创建时解析）。 */
  root: string
  /** 工作区文件夹名（由会话 cwd 算出；分区第一级，见 SPEC §2）。 */
  readonly workspace: string
  /** 父会话 id（fork_from）；无 fork 为空串。 */
  forkFrom: string
  /** fork 基点：只用于首轮 `prev` 的寻址（seq 恒为磁盘最大序号 + 1）。 */
  forkBase: number
  /** 真 seed fork（header.parentSession）：基点等「该目录下的首个 turn/start」再定（见 onTurnStart）。 */
  forkBasePending: boolean
  startedIso: string
  title: string
  model: string
  /** 已落盘轮次总数（resume 时按 turns/ 实际文件数回填；与 `seqs.length` 同步）。 */
  turns: number
  /** 磁盘上已存在的轮次序号集合（SPEC §6 的权威输入：`nextSeq(seqs)` 定下一个序号）。 */
  seqs: number[]
  /* 当前轮缓冲 */
  activeTurn: number | null
  userLines: string[]
  /** agent 回答正文（assistant/message 的 text 块），turn/end 时写入 ## assistant 小节。 */
  assistantLines: string[]
  refNote: string | null
  pendingTools: Map<string, PendingTool>
  toolLines: string[]
}

/** 会话对象里本引擎真正用到的部分（测试用合成对象驱动，不要求完整 Session）。 */
export interface SessionLike {
  readonly id: string
  readonly header?: {
    readonly origin?: 'subagent'
    readonly parentSession?: string
    readonly cwd?: string
    readonly createdAt?: number
  }
}

/** 只取 text 块合并（多块用换行连接）。 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 防御式取消息内容：真实载荷必有 content，但结构异常（缺字段/异构版本）时按空内容处理，
 * 不让一个坏事件抛到 DSH 事件总线上。
 */
function contentOf(message: { content?: readonly ContentBlock[] } | undefined): readonly ContentBlock[] {
  return message?.content ?? []
}

/** 错误对象取一行可读文本。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 记录引擎。五个设置由 `Config` 的 `.volatile()` 字段提供（`config.<field>.get()`，
 * 每个事件重读，不缓存；设置页写入后立刻生效，见 SPEC §8）。
 */
export class RecorderEngine {
  /** 宿主传进来的 Config 实例（五个字段都是稳定引用）。 */
  private readonly config: RecorderConfig
  private readonly sessions = new Map<string, SessionRec>()
  /**
   * 本进程见过的会话 header（来自 `session/created`）。只用于「后续事件载荷没带 header」时补档：
   * 丢了 cwd 就丢了工作区文件夹 → 认不出磁盘上的已有记录。见 `onSessionEvent`。
   */
  private readonly headers = new Map<string, NonNullable<SessionLike['header']>>()
  /** 已 `session/disposed` 的会话 id：headerless 的后续事件不得靠补档把它们重新建档。 */
  private readonly disposed = new Set<string>()

  constructor(config: RecorderConfig = Config({})) {
    this.config = config
  }

  /** 当前设置快照（每次读都重算，改完即时生效）。 */
  private current(): RecorderSettings {
    return settingsOf(this.config)
  }

  /** 记录根：Config 的 root → 内置 `<$DSH_HOME>/_conversations`。 */
  private recorderRoot(): string {
    return resolveRoot(this.current().root, '', defaultRoot())
  }

  /**
   * 会话目录重解析：设置里的 root 改了（live）后，后续轮次立刻落到新根下。
   * 只在真的变了时改动 record，避免每轮都做无谓的字符串比较。
   */
  private refreshDir(rec: SessionRec): void {
    const root = this.recorderRoot()
    if (root === rec.root) return
    rec.root = root
    rec.dir = path.join(root, rec.workspace, safeSessionDir(rec.id))
    // 换 root ⇒ 换到了**另一条记录链**：新根下这个会话目录里的轮次序号集与内存里的无关
    // （旧根下的记录不迁不删、也不参与序号计算，见 SPEC §6/§8）。故重算 fork 基点：
    // 新根下该目录的**首个 turn/start** 重新定基点，与「首次见到该会话」同一口径
    // ——否则真 seed fork 在新根下的首轮 `prev` 会指向父目录里一个根本不存在的轮次（死链）。
    rec.forkBase = 0
    rec.forkBasePending = rec.forkFrom !== ''
  }

  private warn(message: string): void {
    process.stderr.write(`dsh-conversation-recorder: ${message}\n`)
  }

  /**
   * session/created：默认 `header.origin === 'subagent'` 不建档（`recordSubagents` 设置打开才记）。
   *
   * - 懒建：只存内存 record，不建目录、不写 index（首个内容轮次 turn/end 才建）；
   * - `header.parentSession`（真 seed fork）→ 登记 fork_from，基点等首个 turn/start 再定；
   * - resume 自愈：index.md 已存在时从 index + turns/ 回填 turns/title/model，不用空值覆盖。
   */
  onSessionCreated(session: SessionLike): void {
    const header = session.header
    if (header !== undefined) this.headers.set(session.id, header)
    this.disposed.delete(session.id)
    const settings = this.current()
    if (session.header?.origin === 'subagent' && !settings.recordSubagents) return
    const id = session.id
    if (this.sessions.has(id)) return

    let dirName: string
    try {
      dirName = safeSessionDir(id)
    } catch (error: unknown) {
      this.warn(`refuse session ${JSON.stringify(id)}: ${errorText(error)}`)
      return
    }

    const workspace = workspaceDir(session.header?.cwd)
    const root = this.recorderRoot()
    const parent = session.header?.parentSession
    const forkFrom = parent === undefined || parent === '' ? '' : String(parent)
    const rec: SessionRec = {
      id,
      // 分区布局（SPEC §2）：<root>/<工作区文件夹>/<sessionId>/
      dir: path.join(root, workspace, dirName),
      root,
      workspace,
      forkFrom,
      forkBase: 0,
      forkBasePending: forkFrom !== '',
      startedIso: isoFromEpochMs(session.header?.createdAt ?? Date.now()),
      title: '',
      model: '',
      turns: 0,
      seqs: [],
      activeTurn: null,
      userLines: [],
      assistantLines: [],
      refNote: null,
      pendingTools: new Map<string, PendingTool>(),
      toolLines: [],
    }
    this.sessions.set(id, rec)
    this.restoreFromDisk(rec)
  }

  /**
   * resume 自愈：从自身 index.md 读回 title/model/fork_from，并按 turns/ 下
   * `NNNN.md` 的实际序号集合回填 `seqs`/`turns`（磁盘是权威）。读取失败只记 stderr，
   * 不影响后续记录。
   *
   * 序号集合（不是个数）是必需的：被跳过的轮次会在磁盘上留下洞，个数口径认不出洞，
   * 会让后续序号去顶替已有轮次（见 `src/seq.ts`）。
   */
  private restoreFromDisk(rec: SessionRec): void {
    const meta = readIndexMeta(path.join(rec.dir, 'index.md'))
    if (meta !== null) {
      if (meta.title !== '') rec.title = meta.title
      if (meta.model !== '') rec.model = meta.model
      if (rec.forkFrom === '' && meta.forkFrom !== '') rec.forkFrom = meta.forkFrom
    }
    const seqs = scanTurnSeqs(path.join(rec.dir, 'turns'))
    if (seqs === undefined) {
      // turns/ 读不出来（非 ENOENT 的 IO 失败）：退回 index.md 里的 turns 计数，
      // 且**不碰** `seqs`（保持空 ⇒ 若随后真的落盘，会从 0001 起并在撞号时被「拒绝覆写」挡住）
      this.warn(`read turns/ failed for ${rec.dir}; keep index turns=${String(meta?.turns ?? rec.turns)}`)
      if (meta !== null) rec.turns = meta.turns
      return
    }
    rec.seqs = seqs
    rec.turns = seqs.length
  }

  /** session/disposed：会话离开 store，回收内存记录（文件不动）。 */
  onSessionDisposed(session: { readonly id: string }): void {
    this.sessions.delete(session.id)
    // 连 `headers` 一起删：那是「进程内见过的 header」缓存，disposed 之后只剩占用内存的作用；
    // 真宿主重启/重载会对在跑会话重新广播 `session/created`，那时会重新登记。
    this.headers.delete(session.id)
    this.disposed.add(session.id)
  }

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
  onSessionEvent(session: SessionLike, event: SessionEvent): void {
    // `session/disposed` 之后、该会话再次 `session/created` 之前的事件一律不处理
    // （SPEC §2「disposed 时回收内存记录」；真宿主在重启/重新加载时会对在跑会话重新广播
    // `session/created`，那时 `headers`/`disposed` 会被 `onSessionCreated` 刷新，懒建档恢复）。
    if (this.disposed.has(session.id)) return
    let rec = this.sessions.get(session.id)
    if (rec === undefined) {
      const known = this.headers.get(session.id)
      const hint = known !== undefined && session.header === undefined
        ? { id: session.id, header: known }
        : session
      if (hint.header === undefined) return
      this.onSessionCreated(hint)
      rec = this.sessions.get(session.id)
    }
    if (rec === undefined) return
    this.handleEvent(rec, event)
  }

  private handleEvent(rec: SessionRec, event: SessionEvent): void {
    // enabled（SPEC §8）：关闭＝立即停止产出新文件；已有记录不动，正在进行的这一轮丢弃、不落半份。
    // 放在事件处理最前面（含元数据事件），保证关闭期间连 index.md 都不会被补写。
    if (!this.current().enabled) return
    // 插件扩展事件：`session/title` 不在核心 SessionEventMap 联合里（由 dsh-session-title
    // 合并声明），先按运行时字符串识别，避免与核心联合做无交集比较。
    const extended = event as unknown as { type: string; data?: { title?: unknown } }
    if (extended.type === 'session/title') {
      const title = extended.data?.title
      if (typeof title === 'string') {
        rec.title = title
        // emptyIndex（默认 false）：元数据事件不自己建目录，只在轮次已落盘后补写 title
        if (this.current().emptyIndex || fs.existsSync(rec.dir)) this.writeIndex(rec)
      }
      return
    }

    switch (event.type) {
      case 'turn/start': {
        this.onTurnStart(rec, event.data.turn)
        break
      }
      case 'user/message': {
        this.onUserMessage(rec, event.data)
        break
      }
      case 'assistant/message': {
        const text = textOf(contentOf(event.data.message))
        if (text.trim() === '') break // 空 content 只载 usage → 跳过
        if (rec.activeTurn === null) rec.activeTurn = 0
        rec.assistantLines.push(...text.split('\n'))
        break
      }
      case 'tool/call': {
        this.onToolCall(rec, event.data.callId, event.data.name, event.data.arguments)
        break
      }
      case 'tool/result': {
        this.onToolResult(rec, event.data.message, event.data.error)
        break
      }
      case 'turn/end': {
        this.onTurnEnd(rec, event.data.turn, event.data.reason.kind)
        break
      }
      case 'request/context': {
        rec.model = event.data.model
        // emptyIndex（默认 false）：元数据事件不建目录（只发 request/context 不产生空壳）
        if (this.current().emptyIndex || fs.existsSync(rec.dir)) this.writeIndex(rec)
        break
      }
      default:
        break
    }
  }

  /* ---- 轮次缓冲 ---- */

  private onTurnStart(rec: SessionRec, turn: number): void {
    if (rec.forkBasePending) {
      // 真 seed fork：该记录链上的首个 turn/start 的 turn = 已记录轮次 + fork 点 + 1
      // ⇒ base = turn − (turns + 1)，于是首轮 prev 指到父会话的 fork 点，seq 仍按 §6 总则。
      rec.forkBase = turn - (rec.turns + 1)
      rec.forkBasePending = false
    }
    if (rec.activeTurn !== null && rec.activeTurn !== turn) {
      // 理论上一轮结束后才开下一轮；异常则丢弃未落盘缓冲，防序号错乱
      this.discardBuffers(rec)
    }
    rec.activeTurn = turn
    rec.userLines = []
    rec.assistantLines = []
    rec.refNote = null
    rec.pendingTools = new Map<string, PendingTool>()
    rec.toolLines = []
  }

  private discardBuffers(rec: SessionRec): void {
    rec.activeTurn = null
    rec.userLines = []
    rec.assistantLines = []
    rec.refNote = null
    rec.pendingTools = new Map<string, PendingTool>()
    rec.toolLines = []
  }

  /**
   * user/message：`## user` 只收 human（kind=user）与另一个 agent 发来的消息（kind=agent-message）；
   * `session-reference`（@引用）只用来登记 fork_from/引用行，不写进正文。
   */
  private onUserMessage(rec: SessionRec, data: { content: readonly ContentBlock[]; source: unknown }): void {
    const source = data.source as { kind?: string; references?: readonly { sessionId?: string }[] }
    const kind = source.kind ?? ''
    if (kind === 'session-reference') {
      const sid = source.references?.[0]?.sessionId
      if (typeof sid === 'string' && sid !== '') {
        // @引用路径：新会话未被 seed → base 保持 0（seq = turn），只登记血缘与引用行
        if (rec.forkFrom === '') rec.forkFrom = sid
        rec.refNote = sid
      }
      return
    }
    if (kind !== 'user' && kind !== 'agent-message') return
    const text = textOf(contentOf(data))
    if (text.trim() === '') return
    if (rec.activeTurn === null) {
      // 极端顺序：没有 turn/start 的 user/message，仍记入 pending 的下一轮
      rec.activeTurn = 0
    }
    rec.userLines.push(...text.split('\n'))
  }

  private onToolCall(rec: SessionRec, callId: string, name: string, args: string): void {
    if (rec.activeTurn === null) rec.activeTurn = 0
    rec.pendingTools.set(String(callId), {
      name,
      // toolArgsPreview 设置（默认 40，0–200）：工具清单行的参数预览长度
      argsPreview: String(args ?? '').slice(0, this.current().toolArgsPreview),
    })
  }

  /**
   * tool/result：callId 取 `message.toolCallId ?? message.source.callId`（0.2.1 的 v4
   * 载荷把 callId 放在消息顶层，旧载荷在 source 里），结果文本直接取消息 content 的
   * text 块（v4 去掉了旧的 `type:'tool-result'` 包壳），错误码取 `error?.code`。
   * 没有配对 tool/call 的结果不出行（不捏造）；结构异常（无 callId）直接跳过。
   */
  private onToolResult(
    rec: SessionRec,
    message: ToolResultMessage,
    error: { readonly name: string; readonly code: string } | undefined,
  ): void {
    const callId = message.toolCallId ?? message.source?.callId
    if (typeof callId !== 'string' || callId === '') return
    const pending = rec.pendingTools.get(callId)
    if (pending === undefined) return
    rec.pendingTools.delete(callId)
    const text = textOf(contentOf(message))
    const lineCount = text === '' ? 0 : text.split('\n').length
    let line = `- [${callId.slice(0, 12)}] ${pending.name} ${pending.argsPreview} → 结果${lineCount}行`
    if (error !== undefined && typeof error.code === 'string') {
      line += ` [error:${error.code}]`
    }
    rec.toolLines.push(line)
  }

  /**
   * 懒建：只在需要落盘时确保 `<dir>/turns` 存在；失败记 stderr 并返回 false（调用方丢弃该轮）。
   */
  private ensureDir(rec: SessionRec): boolean {
    try {
      fs.mkdirSync(path.join(rec.dir, 'turns'), { recursive: true })
      return true
    } catch (error: unknown) {
      this.warn(`mkdir failed for ${rec.dir}: ${errorText(error)}`)
      return false
    }
  }

  /**
   * turn/end：原子写 `turns/NNNN.md`（.tmp → rename），随后重建 index 轮次表。
   *
   * `seq` = **磁盘上已存在的最大序号 + 1**（SPEC §6，实现在 `src/seq.ts`）——不用绝对 turn 数算，
   * 故重启续跑、fork、被跳过的轮次（写盘失败/被删/外部放置）之后都仍只会**向前**走：
   * 洞被跳过、绝不回填顶替已有轮次（磁盘无洞时与「已落盘轮次数 + 1」逐字等价）。
   * `turn` 只参与 fork 基点（首轮 `prev`）。
   * 写盘失败记 stderr 并丢弃本轮（不重试），该轮不计入序号集合，下一轮仍从同一个 seq 起。
   */
  private onTurnEnd(rec: SessionRec, turn: number, reasonKind: string): void {
    const kind = reasonKind === '' ? 'completed' : reasonKind

    // 空轮次（user / assistant / 工具清单三样全空）不落盘：不建目录、不写文件、不占号。
    if (rec.userLines.length === 0 && rec.assistantLines.length === 0 && rec.toolLines.length === 0) {
      this.discardBuffers(rec)
      return
    }

    // 懒建：首个内容轮次落盘时才建目录；建不出来就丢弃本轮
    this.refreshDir(rec)
    if (!this.ensureDir(rec)) {
      this.discardBuffers(rec)
      return
    }

    // seq 的总则靠磁盘（不是内存猜测）：落盘前先把磁盘上的实际序号集合读进来
    // （洞照读、不回填；读失败保留内存现状，不把读失败当空会话）
    this.syncTurnSeqsFromDisk(rec)

    // fork 基点：真 seed fork 的首个 turn/start 定下绝对 turn 与已落盘轮次的偏移，
    // 之后（含重启续跑）保持 turn −（已落盘 + 1），使首轮 prev 能指到父会话的 fork 点。
    if (rec.forkFrom !== '' && rec.forkBasePending) {
      rec.forkBase = turn - (rec.turns + 1)
      rec.forkBasePending = false
    }

    // seq 总则：磁盘最大序号 + 1（链永远向前增，不给洞回填）
    const { seq, rejected } = nextSeq(rec.seqs)
    if (rejected || seq <= 0) {
      this.warn(`refuse seq ${String(seq)} for ${rec.id} (turn ${String(turn)}, turns ${String(rec.turns)})`)
      this.discardBuffers(rec)
      return
    }
    const target = path.join(rec.dir, 'turns', seqFile(seq))

    // 死规矩：已有文件不被覆写（写同 seq 轮次 → 拒绝且文件不变）
    if (fs.existsSync(target)) {
      this.warn(`refuse overwrite ${target}`)
      this.discardBuffers(rec)
      return
    }

    const body = renderTurn({
      session: rec.id,
      seq,
      time: isoNow(),
      kind,
      prev: this.prevPath(rec, seq),
      userLines: rec.userLines,
      assistantLines: rec.assistantLines,
      refNote: rec.refNote,
      toolLines: rec.toolLines,
    })

    const tmp = target + '.tmp'
    try {
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, target)
    } catch (error: unknown) {
      this.warn(`turn write failed for ${target}: ${errorText(error)}; 丢弃本轮`)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        // 清理失败无所谓：已有 stderr 记录
      }
      this.discardBuffers(rec)
      return
    }

    rec.seqs.push(seq)
    rec.turns = rec.seqs.length
    this.discardBuffers(rec)
    this.writeIndex(rec)
    // 产物文档（SPEC §10）：首个内容轮次落盘后确保根下有 README.md / AGENTS.md。
    // 幂等：已存在就一个字节都不动；写失败只记 stderr，不影响记录。
    // `enabled: false` 时走不到这里（handleEvent 已在最前面拦下全部事件）。
    ensureRootDocs(rec.root)
  }

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
  private prevPath(rec: SessionRec, seq: number): string {
    let prev = 0
    for (const existing of rec.seqs) {
      if (existing < seq && existing > prev) prev = existing
    }
    if (prev > 0) return `turns/${seqFile(prev)}`
    if (rec.forkFrom !== '' && rec.forkBase > 0) {
      return `../${safeSessionDir(rec.forkFrom)}/turns/${seqFile(rec.forkBase)}`
    }
    return ''
  }

  /**
   * 把磁盘上的实际序号集合读进 `rec.seqs`（SPEC §6：序号规则的权威输入）。
   *
   * **每轮结束前都读一次**（磁盘是权威）：于是「被跳过的轮次」（写盘失败留下的洞、
   * 外部删掉的文件）不会让序号回退——旧规则按个数算，洞会让序号被顶替，洞大到
   * 「最大序号 ≫ 个数」时后续记录会被「拒绝覆写」永久卡死（0.2.3 的故障）。
   * 会话目录还不存在时不动内存状态（懒建：首个轮次落盘前没有磁盘可言）。
   * `turns/` 读失败（非 ENOENT）时保留内存现状并记 stderr，不把读失败当空会话。
   */
  private syncTurnSeqsFromDisk(rec: SessionRec): void {
    if (!fs.existsSync(rec.dir)) return
    const seqs = scanTurnSeqs(path.join(rec.dir, 'turns'))
    if (seqs === undefined) {
      this.warn(`read turns/ failed for ${rec.dir}; keep seqs in memory`)
      return
    }
    rec.seqs = seqs
    rec.turns = seqs.length
  }

  /* ---- index.md ---- */

  /**
   * 重建 index.md（frontmatter + 三列轮次表；轮次表按磁盘现状重建）。
   *
   * 建目录时机（SPEC §2/§8）：本函数**默认不建目录**——只有会话目录已经在（即已有轮次落盘）
   * 才重建 index，避免「只发元数据事件」落出空壳目录。`emptyIndex: true` 时允许它自己建。
   */
  private writeIndex(rec: SessionRec): void {
    if (this.current().emptyIndex) {
      if (!this.ensureDir(rec)) return
    } else if (!fs.existsSync(rec.dir)) {
      return
    }
    const rows = readTurnRows(rec.dir)
    if (rec.turns !== rows.length) rec.turns = rows.length
    rec.seqs = rows.map((row) => row.seq)
    const target = path.join(rec.dir, 'index.md')
    const tmp = target + '.tmp'
    try {
      fs.writeFileSync(tmp, renderIndex(rec, rows), 'utf8')
      fs.renameSync(tmp, target)
    } catch (error: unknown) {
      this.warn(`index write failed for ${target}: ${errorText(error)}`)
    }
  }
}

/* ---- cordis 接线 ---- */

/** 本插件用到的 ctx 面（不引入 cordis 运行时/类型依赖，结构兼容即可）。 */
export interface PluginCtx {
  on(event: 'session/created', listener: (session: Session) => void): unknown
  on(event: 'session/disposed', listener: (session: Session) => void): unknown
  on(event: 'session/event', listener: (session: Session, event: SessionEvent) => void): unknown
  /** 运行时注入 settings 服务（0.2.1 的配置模型：插件自己 export Config）。 */
  inject(names: readonly string[], callback: (child: PluginChildCtx) => void): unknown
  /** 插件 fiber：`settings.configure` 的 owner（与宿主官方插件同一写法）。 */
  readonly fiber: unknown
}

/** `ctx.inject(['settings'], child => …)` 里的子上下文。 */
export interface PluginChildCtx {
  effect(callback: () => () => void): unknown
  settings: {
    configure(presentation: { readonly auto?: boolean }, owner?: unknown): () => void
  }
}

/** 监听器兜底：任何异常只记 stderr，不抛回宿主事件总线（一个坏事件不能拖垮会话）。 */
function guard(label: string, run: () => void): void {
  try {
    run()
  } catch (error: unknown) {
    process.stderr.write(`dsh-conversation-recorder: ${label} listener failed: ${errorText(error)}\n`)
  }
}

/**
 * 接线薄壳：把 ctx 事件接到引擎上；`config` 是宿主按 `Config` 解析出的实例
 * （五个字段都是 `.volatile()` 稳定引用，引擎每次事件重读，设置改了立刻生效）。
 *
 * `settings.configure({ auto: false }, ctx.fiber)`：本插件自带设置分区（客户端
 * `configForms`），告诉宿主不要再自动生成一张设置页。
 */
export function apply(ctx: PluginCtx, config: RecorderConfig = Config({})): void {
  const engine = new RecorderEngine(config)
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.on('session/created', (session) => {
    guard('session/created', () => { engine.onSessionCreated(session) })
  })
  ctx.on('session/event', (session, event) => {
    guard('session/event', () => { engine.onSessionEvent(session, event) })
  })
  ctx.on('session/disposed', (session) => {
    guard('session/disposed', () => { engine.onSessionDisposed(session) })
  })
}
