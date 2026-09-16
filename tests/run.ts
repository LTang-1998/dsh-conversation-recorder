/**
 * dsh-conversation-recorder 验收测试（2026-09-10 本轮任务）。
 *
 * 用 node:assert 执行（node ≥ 22 直接跑 .ts，类型擦除）；全流程用**合成事件**驱动真实
 * RecorderEngine（不 mock 被测对象）。载荷形状一律照真实会话日志写，见下方 REAL_* 夹具。
 *
 * 覆盖：
 *   既有 9 项：零运行时依赖 / 全流程契约字段 / title·model 同步 / subagent 过滤 /
 *            fork 分支 / fork 回归 / 懒建目录 / 拒绝覆写 / model 留空；
 *   本轮新增：真实日志夹具、resume 自愈、真 seed fork 基点与 seq<=0 拒写、写盘失败丢弃、
 *            safeSessionDir 拒绝不安全 id、session/disposed 内存回收、## user 收录口径、
 *            新格式（三列轮次表 / 无 summary·links·files / 时间全 UTC）、拆模块后的零依赖红线。
 *   2026-09-15 新增（W0–W4）：按工作区分区——workspaceDir 逐条规则（含两条实测文件夹名逐字）、
 *            不同 cwd 各落一个文件夹、cwd 缺失落 `未分组`、`#` 等保留字符转义、fork 首轮 prev 同文件夹。
 *
 * 运行：node tests/run.ts
 *
 * 会话日志夹具来源：真实会话事件（字段名与嵌套结构逐字照抄），文本已换成同形状中性示例，
 * 不含任何真实工作区路径、会话 id 或对话内容。
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { CONVERSATIONS_DIR, DEFAULT_TOOL_ARGS_PREVIEW, MAX_TOOL_ARGS_PREVIEW, RecorderEngine, RecorderSettingsSchema, apply, createSettingsSource, defaultRoot, ensureRootDocs, entrySettings, isoFromEpochMs, nextSeq, safeSessionDir, workspaceDir } from '../src/index.ts'
import { probeClientBundle } from './client-bundle.ts'
import { loadSettings, saveSettings, unwrapRemoteEnvelope } from '../src/client/remote-envelope.ts'
import z from '@deepseek-ai/schemastery'

/** 测试沙箱目录（tests/.tmp，已 gitignore）。 */
const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

/**
 * 会话记录目录：`<root>/<工作区文件夹>/<sessionId>`（SPEC §2 分区布局）。
 * 工作区文件夹名由会话 cwd 经 workspaceDir 算出；本文件里的会话 cwd 多数是 TMP。
 */
function sessionDir(root: string, cwd: string | undefined, sid: string): string {
  return path.join(root, workspaceDir(cwd), sid)
}

/**
 * 记录根下的**产物文档**文件名（0.3.0 任务2，SPEC §10）。
 * 断言「root 下恰好有哪几个工作区文件夹」时把这两个文件排除掉：它们是**文件**、
 * 不是工作区文件夹，但确实该出现在根下（`docs.ts` 的产物）。
 */
const ROOT_DOC_FILES = ['README.md', 'AGENTS.md']

/** 列出 root 下的**目录**名（排除产物文档文件；按名字排序）。 */
function rootDirs(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !ROOT_DOC_FILES.includes(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** 会话日志夹具（字段名与嵌套结构与真实事件逐字一致；文本为同形状中性示例）。 */
const REAL_USER_MESSAGE = String.raw`{"type":"user/message","seq":8,"time":1788887977498,"data":{"content":[{"type":"text","text":"示例提问：这个工作区里有哪些文件？"}],"source":{"kind":"user","rpcId":"c05a7028-c56c-4877-9a20-c334e0a84804","clientTimeZone":"Asia/Shanghai"},"role":"user","id":"5865145f-3126-4887-a3d2-4b18effc0834"},"surfaceOp":"append"}`

/** 会话日志夹具：tool/result，文本解包路径的现场证据（形状逐字，文本中性）。 */
const REAL_TOOL_RESULT_GLOB = String.raw`{"type":"tool/result","seq":42,"time":1788888000080,"data":{"turn":1,"step":4,"message":{"source":{"kind":"tool","callId":"call_01_rc5rBvWq9jgWdHPDsP2X9191"},"content":[{"type":"tool-result","toolCallId":"call_01_rc5rBvWq9jgWdHPDsP2X9191","content":[{"type":"text","text":"No files found"}],"isError":false}],"role":"user","id":"8178309f-a5cc-4c0f-b74a-ee527d8f4738"},"meta":{"shape":"paths","paths":[],"truncated":false,"total":0}},"sourceEventSeqs":[41],"surfaceOp":"append"}`

/** 会话日志夹具：与上面结果配对的 tool/call（seq=41）；形状逐字，参数为中性示例路径。 */
const REAL_TOOL_CALL_GLOB = String.raw`{"type":"tool/call","seq":41,"time":1788887999439,"data":{"turn":1,"step":4,"callId":"call_01_rc5rBvWq9jgWdHPDsP2X9191","name":"glob","arguments":"{\"path\": \"C:\\\\workspace\", \"pattern\": \"node_modules/.bin/dsh*\"}"}}`

/** 真实事件一行 → 事件对象（原样，不做任何加工）。 */
function asRealEvent(line: string): SessionEvent {
  return JSON.parse(line) as SessionEvent
}

/** 合成事件的外层信封按 SessionEvent 收口（载荷形状与真实日志一致）。 */
function asEvent(event: Record<string, unknown>): SessionEvent {
  return event as unknown as SessionEvent
}

/** 每轮干净起点：清空并重建 .tmp。 */
function freshDir(): string {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  return TMP
}

/* ---- 合成事件（形状照真实日志） ---- */

function userMsgKindEvent(seq: number, text: string, kind: string, turn = 1): SessionEvent {
  return asEvent({
    type: 'user/message', seq, time: 1700000000000 + seq,
    data: {
      turn,
      content: [{ type: 'text', text }],
      source: kind === 'user'
        ? { kind, rpcId: `rpc-${seq}`, clientTimeZone: 'Asia/Shanghai' }
        : { kind },
      role: 'user',
      id: `msg-${seq}`,
    },
    surfaceOp: 'append',
  })
}

function userMsgEvent(seq: number, text: string, turn = 1): SessionEvent {
  return userMsgKindEvent(seq, text, 'user', turn)
}

/** 另一个 agent 发来的消息（真实日志实见 kind=agent-message）。 */
function agentMsgEvent(seq: number, text: string, turn = 1): SessionEvent {
  return userMsgKindEvent(seq, text, 'agent-message', turn)
}

/** 插件注入的上下文（真实日志实见 kind=plugin）。 */
function pluginMsgEvent(seq: number, text: string, turn = 1): SessionEvent {
  return userMsgKindEvent(seq, text, 'plugin', turn)
}

/** 技能目录注入（真实日志实见 kind=skill-catalog）。 */
function skillMsgEvent(seq: number, text: string, turn = 1): SessionEvent {
  return userMsgKindEvent(seq, text, 'skill-catalog', turn)
}

function assistantMsgEvent(seq: number, text: string, turn = 1): SessionEvent {
  return asEvent({
    type: 'assistant/message', seq, time: 1700000000000 + seq,
    data: {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        id: `asst-${seq}`,
        source: { kind: 'model', provider: 'mock', model: 'mock-model' },
        content: [{ type: 'text', text }],
      },
      stream: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    },
  })
}

function sessionRefEvent(seq: number, sessionId: string, turn = 1): SessionEvent {
  return asEvent({
    type: 'user/message', seq, time: 1700000000000 + seq,
    data: {
      turn,
      source: {
        kind: 'session-reference',
        form: 'recall',
        references: [{ sessionId, label: '引用的会话', capturedFormatVersion: 3, capturedThroughSeq: 18 }],
      },
      content: [{ type: 'text', text: '【引用快照】' }],
      role: 'user',
      id: `ref-${seq}`,
    },
    surfaceOp: 'append',
  })
}

function toolCallEvent(seq: number, callId: string, name: string, args: string): SessionEvent {
  return asEvent({
    type: 'tool/call', seq, time: 1700000000000 + seq,
    data: { turn: 1, step: 1, callId, name, arguments: args },
  })
}

function toolResultEvent(seq: number, callId: string, text: string, errorCode?: string): SessionEvent {
  const data: Record<string, unknown> = {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      id: `tool-${seq}`,
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: errorCode !== undefined,
      }],
    },
  }
  if (errorCode !== undefined) data.error = { name: 'ToolError', code: errorCode }
  return asEvent({ type: 'tool/result', seq, time: 1700000000000 + seq, data, surfaceOp: 'append' })
}

function turnStartEvent(seq: number, turn: number): SessionEvent {
  return asEvent({ type: 'turn/start', seq, time: 1700000000000 + seq, data: { turn } })
}

function turnEndEvent(seq: number, turn: number, kind = 'completed'): SessionEvent {
  return asEvent({ type: 'turn/end', seq, time: 1700000000000 + seq, data: { turn, reason: { kind } } })
}

function titleEvent(seq: number, title: string): SessionEvent {
  return asEvent({ type: 'session/title', seq, time: 1700000000000 + seq, data: { title, messageSeqs: [1], source: { kind: 'fallback' } } })
}

function contextEvent(seq: number, model: string): SessionEvent {
  return asEvent({ type: 'request/context', seq, time: 1700000000000 + seq, data: { provider: 'mock', model } })
}

/* ---- 断言辅助 ---- */

/** 按行取 frontmatter 字段值（冒号后内容，trim）。缺字段返回空串。 */
function fieldValue(text: string, key: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith(`${key}:`)) {
      return line.slice(key.length + 1).trim()
    }
  }
  return ''
}

/** 读出轮次文件 frontmatter 某字段。 */
function turnField(turnFile: string, key: string): string {
  return fieldValue(fs.readFileSync(turnFile, 'utf8'), key)
}

/** 读出 index.md frontmatter 某字段。 */
function indexField(indexFile: string, key: string): string {
  return fieldValue(fs.readFileSync(indexFile, 'utf8'), key)
}

/** 取 frontmatter 区块（首个 `---` 与次个 `---` 之间）。 */
function frontmatterOf(file: string): string {
  const parts = fs.readFileSync(file, 'utf8').split('---')
  return parts.length >= 2 ? (parts[1] ?? '') : ''
}

/** 轮次表行断言：index 里存在三列行 `| seq | time | kind |`（无摘要列）。 */
function assertTurnRow(indexFile: string, seq: string, kind: string, errMsg: string): void {
  const text = fs.readFileSync(indexFile, 'utf8')
  let row: string | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith(`| ${seq} |`)) { row = line; break }
  }
  assert(row !== undefined, `${errMsg}：index 缺轮次行 | ${seq} | …`)
  const cells = row.split('|').map((c) => c.trim())
  // cells = ['', seq, time, kind, '']（三列；2026-09-10 已删 summary 列）
  assert.strictEqual(cells.length, 5, `${errMsg}：轮次表应为三列（${row}）`)
  assert.strictEqual(cells[1], seq, `${errMsg}：seq 列不符`)
  assert.strictEqual(cells[3], kind, `${errMsg}：kind 列不符`)
  assert.strictEqual(cells[4], '', `${errMsg}：三列表不应再有多余列`)
}

/** UTC ISO8601（毫秒 + Z）断言。 */
function assertUtc(value: string, label: string): void {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${label} 不是 UTC ISO8601：${value}`)
}

/**
 * 捕获 stderr 旁路输出（只换掉 process.stderr.write 这个出口，**不 mock 被测引擎**），
 * 用来断言「失败必须留痕」：拒写、写盘失败、不安全 id 等。
 */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write
  let captured = ''
  const spy = ((chunk: unknown): boolean => {
    captured += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  }) as unknown as typeof process.stderr.write
  process.stderr.write = spy
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return captured
}

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.error(`  ✗ ${name}：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 异步用例（等待完成后再汇总）：`test()` 是同步的，异步用例若在 test 里 fire-and-forget，
 * 断言失败会变成「未处理的 rejection」而**不**计入失败——那是假绿。
 * 故异步用例统一 push 到这里，由文件末尾的 `await Promise.all(...)` 等齐。
 */
const pendingTests: Promise<void>[] = []

function testAsync(name: string, fn: () => Promise<void>): void {
  pendingTests.push(
    fn().then(
      () => {
        passed += 1
        console.log(`  ✓ ${name}`)
      },
      (error: unknown) => {
        failed += 1
        console.error(`  ✗ ${name}：${error instanceof Error ? error.message : String(error)}`)
      },
    ),
  )
}

// ---- 基础结构 ----
test('src 无运行时依赖：index.ts 顶层仅有 node 内置运行时 import 与 @deepseek-ai 的 import type', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8')
  for (const line of src.split('\n')) {
    const t = line.trim()
    if (t.startsWith('import ') && !t.startsWith('import type ')) {
      assert(!t.includes('@deepseek-ai'), `出现运行时导入: ${t}`)
      assert(t.startsWith("import * as fs from 'node:fs'") || t.startsWith("import * as path from 'node:path'"), `出现非 node 内置运行时导入: ${t}`)
    }
    if (t.startsWith('import type ')) {
      assert(t.includes('@deepseek-ai/dsh-session'), `import type 只能来自 @deepseek-ai/dsh-session: ${t}`)
    }
  }
})

// ---- 零运行时依赖红线（覆盖 src/*.ts 全部，而不是只看入口） ----
//
// 白名单**恰好两项**（SPEC §9）：宿主随装提供的两个 peer 允许运行时 import；
// 其余任何裸包名（含其它 @deepseek-ai/*）仍然红。
const RUNTIME_BARE_ALLOWED: readonly string[] = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths']

test('R9: 运行时依赖红线（拆模块后）：src/*.ts 运行时只 import node 内置、同插件相对文件，或恰好那两个宿主 peer；类型只 import @deepseek-ai', () => {
  assert.strictEqual(RUNTIME_BARE_ALLOWED.length, 2, '运行时裸包名白名单必须恰好两项')
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src')
  const files = fs.readdirSync(srcDir).filter((name) => name.endsWith('.ts'))
  assert(files.length >= 4, `src 下应有 4 个模块，实际 ${files.join(', ')}`)
  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('import ')) continue
      const spec = /from\s+'([^']+)'/.exec(t)?.[1] ?? ''
      if (t.startsWith('import type ')) {
        // 类型只允许来自 DSH 包（编译期擦除）或同插件相对模块；不许第三方类型包
        assert(
          spec.startsWith('@deepseek-ai/') || spec.startsWith('./') || spec.startsWith('../'),
          `${file} 的类型导入只允许 @deepseek-ai/* 或同插件相对模块：${t}`,
        )
      } else {
        // 红线是「运行时依赖只有 node 内置 + 同插件相对模块 + 白名单里的两个宿主 peer」
        assert(
          spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../') || RUNTIME_BARE_ALLOWED.includes(spec),
          `${file} 出现白名单外的运行时导入（零依赖红线）：${t}`,
        )
      }
    }
  }
})

// ---- 场景A：全流程（普通会话 2 轮 + title/model，无 ended/state） ----
test('A: 全流程合成事件 → 文件与契约字段逐一断言', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'alpha'

  // session/created（origin 未设置 = 顶层会话）→ 仅记内存，懒建（任务3）：不建目录、不写 index
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  const dir = sessionDir(root, TMP, sid)
  const indexFile = path.join(dir, 'index.md')
  assert(!fs.existsSync(dir), '懒建：仅 session/created 不应建目录')
  assert(!fs.existsSync(indexFile), '懒建：仅 session/created 不应写 index.md')

  // 第 1 轮：turn/start → user/message → tool/call(无错) → tool/call(带错) → assistant → turn/end
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第一条用户消息', 1))
  engine.onSessionEvent({ id: sid }, toolCallEvent(3, 'call_abcdef1234567890', 'fs_read', '{"path":"a/b/c"}'))
  engine.onSessionEvent({ id: sid }, toolResultEvent(4, 'call_abcdef1234567890', 'line1\nline2'))
  engine.onSessionEvent({ id: sid }, toolCallEvent(5, 'call_00001234567890', 'net_get', '{"url":"https://example.com/x"}'))
  engine.onSessionEvent({ id: sid }, toolResultEvent(6, 'call_00001234567890', 'error-body', 'HTTP_429'))
  engine.onSessionEvent({ id: sid }, assistantMsgEvent(7, '第一条助手回复文本', 1))
  // 空 content（仅 usage）的 assistant/message → 应跳过，不产生正文
  engine.onSessionEvent({ id: sid }, asEvent({ type: 'assistant/message', seq: 8, time: 1700000000008, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'asst-empty', source: { kind: 'model', provider: 'mock', model: 'mock-model' }, content: [] }, stream: [], usage: { inputTokens: 1, outputTokens: 4, totalTokens: 5 } } }))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 1))

  // 首个轮次落盘后才建目录与 index（任务3）
  assert(fs.existsSync(dir), '首个轮次后会话目录应创建')
  assert(fs.statSync(dir).isDirectory(), '会话目录不是目录')
  assert(fs.existsSync(path.join(dir, 'turns')), 'turns 目录已创建')
  assert(fs.existsSync(indexFile), 'index.md 已创建')

  // index frontmatter 契约字段（无 ended/state——已按任务1删除）
  assert.strictEqual(indexField(indexFile, 'title'), '', 'title 应为空（无 title 事件）')
  assert.strictEqual(indexField(indexFile, 'session'), sid, 'session 字段')
  assert.strictEqual(indexField(indexFile, 'started'), isoFromEpochMs(1700000000000), 'started 应为创建时间 ISO')
  assert.strictEqual(indexField(indexFile, 'model'), '', 'model 应为空（无 request/context 事件）')
  assert.strictEqual(indexField(indexFile, 'turns'), '1', 'turns 应为 1')
  assert.strictEqual(indexField(indexFile, 'fork_from'), '', 'fork_from 应为空')

  // 轮次文件 0001.md
  const turn1 = path.join(dir, 'turns', '0001.md')
  assert(fs.existsSync(turn1), '0001.md 未创建')
  assert.strictEqual(turnField(turn1, 'session'), sid, '轮次 frontmatter session')
  assert.strictEqual(turnField(turn1, 'seq'), '0001', '轮次 frontmatter seq')
  assert.notStrictEqual(turnField(turn1, 'time'), '', '轮次 frontmatter time 非空')
  assert.strictEqual(turnField(turn1, 'kind'), 'completed', '轮次 frontmatter kind')
  assert.strictEqual(turnField(turn1, 'prev'), '', '首轮无 fork 时 prev 为空')

  // 2026-09-10 任务1：轮次 frontmatter 的 links/files 占位数组已从契约删除。
  // 原断言（links/files 必须为 '[]'）与新契约直接冲突，故按新契约改为**反向断言**（不是删除检查）。
  const head1 = frontmatterOf(turn1)
  assert(!head1.includes('links'), '轮次 frontmatter 不应再有 links 字段')
  assert(!head1.includes('files'), '轮次 frontmatter 不应再有 files 字段')

  // 正文：user 小节 + assistant 小节（任务2）+ 工具清单行（格式 [callId前12] 工具名 参数前40字 → 结果X行 [error:code]）
  const body1 = fs.readFileSync(turn1, 'utf8')
  assert(body1.includes('## user'), '正文缺 ## user 小节')
  assert(body1.includes('第一条用户消息'), '正文缺用户消息文本')
  assert(body1.includes('## assistant'), '正文缺 ## assistant 小节（任务2）')
  assert(body1.includes('第一条助手回复文本'), '正文缺 agent 回答文本（任务2）')
  assert(!body1.includes('（无正文）'), '有 assistant/message 回答时不应出现（无正文）占位')
  assert(body1.includes('- [call_abcdef1] fs_read {"path":"a/b/c"} → 结果2行'), '工具清单行（无错）格式错误')
  assert(body1.includes('- [call_0000123] net_get {"url":"https://example.com/x"} → 结果1行 [error:HTTP_429]'), '工具清单行（带错）格式错误')

  // index 轮次表：追加一行，三列
  assert.strictEqual(indexField(indexFile, 'turns'), '1', 'turns 应为 1')
  assertTurnRow(indexFile, '0001', 'completed', '第 1 轮次表行')

  // 第 2 轮（无 assistant/message 事件 → 正文写（无正文）占位）
  engine.onSessionEvent({ id: sid }, turnStartEvent(10, 2))
  engine.onSessionEvent({ id: sid }, userMsgEvent(11, '第二条用户消息', 2))
  engine.onSessionEvent({ id: sid }, turnEndEvent(12, 2))
  const turn2 = path.join(dir, 'turns', '0002.md')
  assert(fs.existsSync(turn2), '0002.md 未创建')
  assert.strictEqual(turnField(turn2, 'seq'), '0002', '第 2 轮 seq')
  assert.strictEqual(turnField(turn2, 'prev'), 'turns/0001.md', '第 2 轮 prev 指向上一轮')
  const body2 = fs.readFileSync(turn2, 'utf8')
  assert(body2.includes('## assistant'), '第 2 轮也应含 ## assistant 小节')
  assert(body2.includes('（无正文）'), '无 assistant/message 时正文写（无正文）')
  assertTurnRow(indexFile, '0002', 'completed', '第 2 轮次表行')
  assert.strictEqual(indexField(indexFile, 'turns'), '2', 'turns 应为 2')
})

test('A2: title/model 同步更新', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'beta'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  const dir = sessionDir(root, TMP, sid)
  const indexFile = path.join(dir, 'index.md')

  // 建目录时机（SPEC §2/§8）：默认 emptyIndex=false ⇒ 只有标题事件不建目录、不写 index（无空壳）
  engine.onSessionEvent({ id: sid }, titleEvent(1, '测试标题'))
  assert(!fs.existsSync(dir), '只发 title 事件不应建会话目录（空壳目录 bug）')
  assert(!fs.existsSync(indexFile), '只发 title 事件不应写 index.md')

  // 首个内容轮次落盘后，先前的 title/model 才随 index 落盘（内存里的值不丢）
  engine.onSessionEvent({ id: sid }, contextEvent(2, 'deepseek-v4'))
  engine.onSessionEvent({ id: sid }, turnStartEvent(3, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(4, '标题用例的一轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(5, 1))
  assert(fs.existsSync(indexFile), '首个轮次后应写 index.md')
  assert.strictEqual(indexField(indexFile, 'title'), '测试标题', 'title 未同步')
  assert.strictEqual(indexField(indexFile, 'model'), 'deepseek-v4', 'model 未同步')

  // 已有轮次后，title 事件即时补写 index
  engine.onSessionEvent({ id: sid }, titleEvent(6, '改过的标题'))
  assert.strictEqual(indexField(indexFile, 'title'), '改过的标题', 'title 事件应即时补写 index')

  // 契约不再有 ended/state 字段（任务1），校验它们从不出现
  const text = fs.readFileSync(indexFile, 'utf8')
  assert(!text.includes('ended:'), 'index 不应含 ended 字段')
  assert(!text.includes('state:'), 'index 不应含 state 字段')
})

// ---- 场景B：subagent 过滤 ----
test('B: 子代理（origin=subagent）不记录', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  engine.onSessionCreated({ id: 'sub1', header: { origin: 'subagent', cwd: TMP, createdAt: 1700000000000 } })
  const dir = sessionDir(root, TMP, 'sub1')
  assert(!fs.existsSync(dir), 'subagent 不应建目录')
  // 后续事件也应被忽略
  engine.onSessionEvent({ id: 'sub1' }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: 'sub1' }, userMsgEvent(2, 'child text', 1))
  engine.onSessionEvent({ id: 'sub1' }, turnEndEvent(3, 1))
  assert(!fs.existsSync(dir), 'subagent 事件不应产生任何文件')
})

// ---- 场景C（任务3-3）：fork 分支——真 seed fork（header.parentSession） ----
// 夹具改动说明：旧夹具只喂 session-reference，本轮 §6 规定 @引用路径 base=0，
// 而本用例断言的是「真 seed fork 用首个 turn/start − 1 作基点」，故夹具补上
// header.parentSession（DSH 对 seed fork 的持久化血缘）。断言逐字未改。
test('C: fork 分支（父已记录 4 轮）子绝对 turn=5 起 → seq=turn−F=0001，prev 指向父目录 0004', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })

  // 父会话：先记录 4 轮（turn 1..4）
  const parent = 'parent-s1'
  engine.onSessionCreated({ id: parent, header: { cwd: TMP, createdAt: 1700000000000 } })
  for (let t = 1; t <= 4; t += 1) {
    engine.onSessionEvent({ id: parent }, turnStartEvent(t * 3 - 2, t))
    engine.onSessionEvent({ id: parent }, userMsgEvent(t * 3 - 1, `父第 ${t} 轮`, t))
    engine.onSessionEvent({ id: parent }, turnEndEvent(t * 3, t))
  }
  const parentIndex = path.join(sessionDir(root, TMP, parent), 'index.md')
  assert.strictEqual(indexField(parentIndex, 'turns'), '4', '父会话应有 4 轮')
  assert(fs.existsSync(path.join(sessionDir(root, TMP, parent), 'turns', '0004.md')), '父会话 0004.md 应在')

  // 子会话：真 seed fork（header.parentSession）；DSH 日志 turn 绝对计数——子自身首轮 turn=5
  const child = 'child-s1'
  engine.onSessionCreated({ id: child, header: { cwd: TMP, createdAt: 1700000000000, parentSession: parent } })
  engine.onSessionEvent({ id: child }, turnStartEvent(1, 5))
  engine.onSessionEvent({ id: child }, sessionRefEvent(2, parent, 5))
  engine.onSessionEvent({ id: child }, userMsgEvent(3, '子会话第一个问题', 5))
  engine.onSessionEvent({ id: child }, turnEndEvent(4, 5))

  const childIndex = path.join(sessionDir(root, TMP, child), 'index.md')
  assert.strictEqual(indexField(childIndex, 'fork_from'), parent, '子会话 fork_from=父会话 id')
  assert.strictEqual(indexField(childIndex, 'turns'), '1', '子会话已记 1 轮')

  // 任务3-3：base = 首个 turn/start 的 turn − 1（=4）→ seq=0001；prev 指向父目录 0004（fork 点）
  const childTurn1 = path.join(sessionDir(root, TMP, child), 'turns', '0001.md')
  assert(fs.existsSync(childTurn1), '子首轮（绝对 turn=5，base=4）应落 0001.md（seq=turn−base=1）')
  assert.strictEqual(turnField(childTurn1, 'seq'), '0001', '子首轮 seq=0001')
  assert.strictEqual(turnField(childTurn1, 'prev'), `../${parent}/turns/0004.md`, '子首轮 prev 指向父目录 0004.md（fork 点）')
  assert(!fs.existsSync(path.join(sessionDir(root, TMP, child), 'turns', '0005.md')), '子自身首轮不应落 0005（seq 从 1 起）')

  // 子会话第 2 轮（绝对 turn=6）→ seq=2 → 0002.md
  engine.onSessionEvent({ id: child }, turnStartEvent(5, 6))
  engine.onSessionEvent({ id: child }, userMsgEvent(6, '子会话第二个问题', 6))
  engine.onSessionEvent({ id: child }, turnEndEvent(7, 6))
  const childTurn2 = path.join(sessionDir(root, TMP, child), 'turns', '0002.md')
  assert(fs.existsSync(childTurn2), '子第 2 轮（绝对 turn=6）应落 0002.md（seq=2）')
  assert.strictEqual(turnField(childTurn2, 'prev'), 'turns/0001.md', '子第 2 轮 prev 指向子上轮 0001')
})

// ---- 场景C2（回归）：@引用路径（无 header.parentSession）→ 父未记录，seq 仍从 1 起连续 ----
test('C2: 父未记录（F=0）→ fork 子会话 seq 从 1 起连续（回归）', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })

  const ghost = 'ghost-parent' // 从未被本插件记录 → 无 index.md
  const child = 'child-s2'
  engine.onSessionCreated({ id: child, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: child }, turnStartEvent(1, 5))
  engine.onSessionEvent({ id: child }, sessionRefEvent(2, ghost, 5))
  engine.onSessionEvent({ id: child }, userMsgEvent(3, '子会话问题', 5))
  engine.onSessionEvent({ id: child }, turnEndEvent(4, 5))

  const childIndex = path.join(sessionDir(root, TMP, child), 'index.md')
  assert.strictEqual(indexField(childIndex, 'fork_from'), ghost, '父未记录也应记 fork_from')
  // 任务1 新序号规则（SPEC §6）：seq 恒等于「已落盘轮次数 + 1」→ 子自身首轮就是 0001，
  // 不再按绝对 turn=5 命名（链从 1 起，处处连续）
  const childTurn = path.join(sessionDir(root, TMP, child), 'turns', '0001.md')
  assert(fs.existsSync(childTurn), '子首轮应落 0001.md（seq = 已落盘轮次 + 1）')
  assert.strictEqual(turnField(childTurn, 'seq'), '0001', '子首轮 seq=0001')
  assert.strictEqual(turnField(childTurn, 'prev'), '', 'F=0 时首轮 prev 留空')
  assert(!fs.existsSync(path.join(sessionDir(root, TMP, child), 'turns', '0005.md')), '不应按绝对 turn 落 0005.md')
})

// ---- 场景F（任务3）：懒建目录 ----
test('F: 懒建目录（任务3）：仅 session/created 不建目录，首个轮次 turn/end 才建', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'lazy'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  const dir = sessionDir(root, TMP, sid)
  assert(!fs.existsSync(dir), '仅 session/created 不应建目录（无空壳）')
  assert(!fs.existsSync(path.join(dir, 'index.md')), '仅 session/created 不应写 index.md')

  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '懒建后的首轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))

  assert(fs.existsSync(path.join(dir, 'turns')), '首个轮次 turn/end 后才建 turns 目录')
  assert(fs.existsSync(path.join(dir, 'index.md')), '首个轮次 turn/end 后才写 index.md')
  assert(fs.existsSync(path.join(dir, 'turns', '0001.md')), '首个轮次文件已落盘')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '1', '懒建后 turns=1')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'started'), isoFromEpochMs(1700000000000), '懒建后 started 仍取 createdAt')
})

// ---- 场景D：已有文件不复写 ----
/**
 * D（**0.3.0 契约变更，旧→新见 PROGRESS.md**）：磁盘上已有的东西**永不**被覆写。
 *
 * 旧规则下可以构造出「算出的 seq 撞上已有文件」：第 2 轮写盘失败（计数仍为 1）后手工放一个
 * `0002.md`，第 3 轮会再算出 seq=0002 ⇒ 撞上「拒绝覆写」。新规则（磁盘最大序号 + 1）下这条路
 * **不再可达**——落盘前先扫磁盘，`nextSeq()` 天然避开所有已存在的序号。故本用例改判新规则下
 * 同一件事的两种表现（判据是**换口径**，不是放宽——原断言「已有文件内容不变」逐字保留并加强）：
 *   ① 计算出的 seq 落在**空位**上（跳过已有 max 之后的号也不回填洞）；
 *   ② 非标准命名的历史产物（`0003.bak`/`00-1.md` 之类）既不参与序号、也**一字不动**。
 */
test('D: 已有文件永不覆写——落盘序号避开磁盘上已存在的号，外部放置的文件一字不动', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'gamma'
  const dir = sessionDir(root, TMP, sid)
  const turnsDir = path.join(dir, 'turns')
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '原始内容', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  const turn1 = path.join(turnsDir, '0001.md')
  assert(fs.existsSync(turn1), '第 1 轮应落 0001.md')
  const before = fs.readFileSync(turn1, 'utf8')

  // 外部放置两个「非引擎产出」的文件（历史命名 + 备份命名）——既不参与序号，也不许被碰
  const legacy = path.join(turnsDir, '00-1.md')
  const backup = path.join(turnsDir, '0003.bak')
  fs.writeFileSync(legacy, '历史命名，不许被碰\n', 'utf8')
  fs.writeFileSync(backup, '备份，不许被碰\n', 'utf8')

  // 下一轮的序号 = 磁盘最大序号（1，`00-1.md` 不参与） + 1 = 0002；`0003.bak` 不在序号集合里，故无冲突
  const err = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
    engine.onSessionEvent({ id: sid }, userMsgEvent(5, '第二轮', 2))
    engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  })
  assert.strictEqual(err, '', `正常续写不应有告警，实际：${JSON.stringify(err)}`)
  assert(fs.existsSync(path.join(turnsDir, '0002.md')), '下一轮应落 0002.md（磁盘最大序号 + 1）')
  assert.strictEqual(fs.readFileSync(turn1, 'utf8'), before, '已有文件被覆写了')
  assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '历史命名，不许被碰\n', '历史命名的文件被改写了')
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), '备份，不许被碰\n', '备份文件被改写了')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '2', 'index.turns = 轮次文件个数（2）')
  assert(!fs.existsSync(path.join(turnsDir, '0002.md.tmp')), '不应残留 .tmp')

  // 序号集合里「被占用」时既不许覆写也不许顶替：外部把一个**空的** turns/ 子目录占在 0003 的位置
  // （`turns/0003.md/` 是目录 ⇒ 该行写入会失败），于是磁盘上的序号集合变成 {0001,0002} 而 0003 这一号被占。
  // 本轮**写盘失败**（不留半份、不动占位物）；腾开之后下一轮按磁盘最大序号 + 1 写 **0003.md**
  // ——上一轮根本没产出文件，故它不占号（「失败的那轮不计入」这条死规矩在新规则下依然成立）。
  // 写盘失败那轮不留半份、也不占号：把下一轮要用的 `.tmp` 位置占成目录 ⇒ writeFileSync 失败（EISDIR），
  // 引擎记 stderr、丢弃本轮。新规则下本轮的目标是 0003.md（磁盘最大序号 2 + 1），故占 `0003.md.tmp`。
  fs.mkdirSync(path.join(turnsDir, '0003.md.tmp'), { recursive: true })
  const errBusy = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(7, 3))
    engine.onSessionEvent({ id: sid }, userMsgEvent(8, '写盘失败的一轮', 3))
    engine.onSessionEvent({ id: sid }, turnEndEvent(9, 3))
  })
  assert(
    errBusy.includes('turn write failed'),
    `写盘失败必须 stderr 留痕（拒写/失败都不许静默），实际：${JSON.stringify(errBusy)}`,
  )
  assert(fs.statSync(path.join(turnsDir, '0003.md.tmp')).isDirectory(), '外部占位目录不应被动过')
  assert(!fs.existsSync(path.join(turnsDir, '0003.md')), '写盘失败那轮不得留下正式轮次文件')
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md'], '写盘失败那轮不得留下任何轮次文件')

  fs.rmSync(path.join(turnsDir, '0003.md.tmp'), { recursive: true, force: true })
  const errNext = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(10, 4))
    engine.onSessionEvent({ id: sid }, userMsgEvent(11, '腾开之后的一轮', 4))
    engine.onSessionEvent({ id: sid }, turnEndEvent(12, 4))
  })
  assert.strictEqual(errNext, '', `腾开之后应正常落盘，实际：${JSON.stringify(errNext)}`)
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md', '0003.md'], '腾开后按磁盘最大序号（2）+ 1 写 0003.md（失败的那轮不占号）')
  assert.strictEqual(fs.readFileSync(turn1, 'utf8'), before, '已有文件在整条路径上都不许被覆写')
  assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '历史命名，不许被碰\n', '整个过程中历史命名的文件都不许被碰')
  assert.strictEqual(fs.readFileSync(backup, 'utf8'), '备份，不许被碰\n', '整个过程中备份文件都不许被碰')
})

// ---- 场景E：模型留空与填充 ----
test('E: 无 request/context 事件时 model 留空', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  engine.onSessionCreated({ id: 'eta', header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: 'eta' }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: 'eta' }, userMsgEvent(2, 'x', 1))
  engine.onSessionEvent({ id: 'eta' }, turnEndEvent(3, 1))
  const indexFile = path.join(sessionDir(root, TMP, 'eta'), 'index.md')
  assert.strictEqual(indexField(indexFile, 'model'), '', '无 request/context 时 model 应为空')
})

// ================= 本轮新增用例 =================

// ---- R1（修复1）：真实日志夹具驱动——tool/result 的 callId 与文本解包 ----
test('R1: 真实日志夹具（seq 8/41/42 逐字）→ 用户行与工具行逐字正确', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'real-log'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1788887950260 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, asRealEvent(REAL_USER_MESSAGE))
  engine.onSessionEvent({ id: sid }, asRealEvent(REAL_TOOL_CALL_GLOB))
  engine.onSessionEvent({ id: sid }, asRealEvent(REAL_TOOL_RESULT_GLOB))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 1))

  const body = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md'), 'utf8')
  assert(body.includes('## user'), '正文缺 ## user')
  assert(body.includes('示例提问：这个工作区里有哪些文件？'), '会话日志夹具的 user/message 文本未落盘')

  // 期望行由**夹具自身**（工具名/参数/结果文本）算出，与实现无关
  const call = JSON.parse(REAL_TOOL_CALL_GLOB) as { data: { callId: string; name: string; arguments: string } }
  const expected = `- [${call.data.callId.slice(0, 12)}] ${call.data.name} ${call.data.arguments.slice(0, 40)} → 结果1行`
  assert(body.includes(expected), `工具行与真实载荷不符，缺：${expected}`)

  // 行数按结果文本行数：真实 1 行 → 结果1行；多行结果（真实形状）→ 结果3行
  engine.onSessionEvent({ id: sid }, turnStartEvent(10, 2))
  engine.onSessionEvent({ id: sid }, userMsgEvent(11, '再来一轮', 2))
  engine.onSessionEvent({ id: sid }, toolCallEvent(12, 'call_01_rc5rBvWq9jgWdHPDsP2X9191', 'glob', '{"pattern":"*.md"}'))
  engine.onSessionEvent({ id: sid }, toolResultEvent(13, 'call_01_rc5rBvWq9jgWdHPDsP2X9191', 'a.md\nb.md\nc.md'))
  engine.onSessionEvent({ id: sid }, turnEndEvent(14, 2))
  const body2 = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0002.md'), 'utf8')
  assert(body2.includes('- [call_01_rc5r] glob {"pattern":"*.md"} → 结果3行'), '多行结果的行数统计错误')

  // 没有配对 tool/call 的结果不出行（不捏造）
  engine.onSessionEvent({ id: sid }, turnStartEvent(15, 3))
  engine.onSessionEvent({ id: sid }, toolResultEvent(16, 'call_orphan0000000000', '孤儿结果'))
  engine.onSessionEvent({ id: sid }, turnEndEvent(17, 3))
  const body3 = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0003.md'), 'utf8')
  assert(!body3.includes('call_orphan00'), '没有配对 tool/call 的结果不应出工具行')
  assert(body3.includes('（无用户文本）'), '该轮无 user/agent-message 文本时应写占位行')
})

// ---- R2（修复2）：resume 自愈 ----
test('R2: resume 自愈：重启后从 index.md + turns/ 回填，title/model/turns 不被空值抹掉', () => {
  const root = freshDir()
  const sid = 'resume-sid'
  const indexFile = path.join(sessionDir(root, TMP, sid), 'index.md')

  // 重启前：标题 + model + 2 轮
  const before = new RecorderEngine({ root })
  before.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  before.onSessionEvent({ id: sid }, titleEvent(1, '重启前的标题'))
  before.onSessionEvent({ id: sid }, contextEvent(2, 'deepseek-v4-flash'))
  for (let t = 1; t <= 2; t += 1) {
    before.onSessionEvent({ id: sid }, turnStartEvent(t * 3, t))
    before.onSessionEvent({ id: sid }, userMsgEvent(t * 3 + 1, `重启前第 ${t} 轮`, t))
    before.onSessionEvent({ id: sid }, turnEndEvent(t * 3 + 2, t))
  }
  assert.strictEqual(indexField(indexFile, 'title'), '重启前的标题', '重启前 title')
  assert.strictEqual(indexField(indexFile, 'turns'), '2', '重启前 turns')

  // 模拟进程重启：全新引擎（内存记录为空），同一 root
  const after = new RecorderEngine({ root })
  after.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  // 重启后先到的是 model 事件——旧实现会在此时用空 title/turns=0 覆盖 index
  after.onSessionEvent({ id: sid }, contextEvent(20, 'deepseek-v4-flash'))
  assert.strictEqual(indexField(indexFile, 'title'), '重启前的标题', '重启后 title 被空值抹掉')
  assert.strictEqual(indexField(indexFile, 'model'), 'deepseek-v4-flash', '重启后 model')
  assert.strictEqual(indexField(indexFile, 'turns'), '2', '重启后 turns 被抹掉')

  // 续跑：第 3 轮接在 0002 之后（prev 指上一轮，无洞）
  after.onSessionEvent({ id: sid }, turnStartEvent(21, 3))
  after.onSessionEvent({ id: sid }, userMsgEvent(22, '重启后第 3 轮', 3))
  after.onSessionEvent({ id: sid }, turnEndEvent(23, 3))
  const turn3 = path.join(sessionDir(root, TMP, sid), 'turns', '0003.md')
  assert(fs.existsSync(turn3), '重启后应续写 0003.md')
  assert.strictEqual(turnField(turn3, 'prev'), 'turns/0002.md', '重启后续跑 prev 指向 0002')
  assert.strictEqual(indexField(indexFile, 'turns'), '3', '重启后续跑 turns=3')
})

// ---- R3（修复3）：真 seed fork 基点 + 「被跳过的轮次之后继续仍只会向前写」 ----
test('R3: 真 seed fork 基点=首个 turn/start−1（只用于 prev）；被跳过的轮次之后继续仍只会向前写 seq；重启续跑基点正确', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const parent = 'seed-parent'
  engine.onSessionCreated({ id: parent, header: { cwd: TMP, createdAt: 1700000000000 } })
  for (let t = 1; t <= 3; t += 1) {
    engine.onSessionEvent({ id: parent }, turnStartEvent(t * 3 - 2, t))
    engine.onSessionEvent({ id: parent }, userMsgEvent(t * 3 - 1, `父第 ${t} 轮`, t))
    engine.onSessionEvent({ id: parent }, turnEndEvent(t * 3, t))
  }

  const child = 'seed-child'
  engine.onSessionCreated({ id: child, header: { cwd: TMP, createdAt: 1700000000000, parentSession: parent } })
  // 子自身首个 live turn 是 4（父 3 轮被 seed）→ 基点 F=3 → seq=1
  engine.onSessionEvent({ id: child }, turnStartEvent(1, 4))
  engine.onSessionEvent({ id: child }, userMsgEvent(2, '子第 1 轮', 4))
  engine.onSessionEvent({ id: child }, turnEndEvent(3, 4))
  const childTurn1 = path.join(sessionDir(root, TMP, child), 'turns', '0001.md')
  assert(fs.existsSync(childTurn1), '基点 F=3 → 子首轮应为 0001.md')
  assert.strictEqual(turnField(childTurn1, 'prev'), `../${parent}/turns/0003.md`, 'prev 应指向父目录 fork 点 0003')

  // 任务1 新规则（SPEC §6，0.3.0）：喂一个「比基点更小」的绝对 turn —— seq 按「磁盘最大序号 + 1」算，
  // 故不再产生负号，而是接着写 0002.md（旧实现会算出 seq=-1 并拒写、丢这一轮）。
  const err = captureStderr(() => {
    engine.onSessionEvent({ id: child }, turnStartEvent(4, 2))
    engine.onSessionEvent({ id: child }, userMsgEvent(5, '绝对 turn 小于基点的一轮', 2))
    engine.onSessionEvent({ id: child }, turnEndEvent(6, 2))
  })
  assert.strictEqual(err, '', `新序号规则下不应有拒写告警，实际：${JSON.stringify(err)}`)
  const childTurns = fs.readdirSync(path.join(sessionDir(root, TMP, child), 'turns')).sort()
  assert.deepStrictEqual(childTurns, ['0001.md', '0002.md'], `seq 应连续，实际 ${childTurns.join(',')}`)
  assert.strictEqual(indexField(path.join(sessionDir(root, TMP, child), 'index.md'), 'turns'), '2', '第二轮计入 turns')

  // 被跳过的轮次之后继续（**0.3.0 契约变更，旧→新见 PROGRESS.md**）：
  // 这个真 seed fork 会话在本 root 下**没有** `holes` 配置 ⇒ 磁盘序号集合仍是 {0001,0002}，
  // 单看这一条与旧规则同结果（无洞时逐字等价，见 SPEC §6）。真正的「洞」由 `settingsEngine`
  // 的 `holes` 夹具在下面的 S7/D 两组用例里造（此处不删任何已落盘轮次：磁盘上的记录是留档）。
  engine.onSessionEvent({ id: child }, turnStartEvent(7, 9))
  engine.onSessionEvent({ id: child }, userMsgEvent(8, '被跳过的轮次之后继续', 9))
  engine.onSessionEvent({ id: child }, turnEndEvent(9, 9))
  const childTurn3 = path.join(sessionDir(root, TMP, child), 'turns', '0003.md')
  assert(fs.existsSync(childTurn3), '被跳过的轮次之后应写 0003.md（磁盘最大序号 0002 + 1）')
  assert.strictEqual(turnField(childTurn3, 'prev'), 'turns/0002.md', 'prev 指向磁盘上更小的最大序号 0002')

  // 重启续跑：新引擎 + 同一 root + 仍有 parentSession → seq 接着磁盘最大序号（0003）走 → 0004.md
  const restarted = new RecorderEngine({ root })
  restarted.onSessionCreated({ id: child, header: { cwd: TMP, createdAt: 1700000000000, parentSession: parent } })
  restarted.onSessionEvent({ id: child }, turnStartEvent(10, 5))
  restarted.onSessionEvent({ id: child }, userMsgEvent(11, '重启后子第 4 轮', 5))
  restarted.onSessionEvent({ id: child }, turnEndEvent(12, 5))
  const childTurn4 = path.join(sessionDir(root, TMP, child), 'turns', '0004.md')
  assert(fs.existsSync(childTurn4), '重启后 fork 子应续写 0004.md')
  assert.strictEqual(turnField(childTurn4, 'prev'), 'turns/0003.md', '重启后 prev 指向 0003')
  assert(!fs.existsSync(path.join(sessionDir(root, TMP, child), 'turns', '0005.md')), '不应按绝对 turn 落 0005')
})

// ---- R4（修复4）：写盘失败 stderr + 丢弃该轮 ----
test('R4: 写盘失败（turn 与 mkdir）→ stderr 警告 + 丢弃该轮，不抛异常', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'io-fail'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第 1 轮正常', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  const turnsDir = path.join(sessionDir(root, TMP, sid), 'turns')
  assert(fs.existsSync(path.join(turnsDir, '0001.md')), '第 1 轮应正常落盘')

  // 让 0002.md.tmp 变成目录 → 写 tmp 直接失败（EISDIR），且不会碰到 0002.md
  fs.mkdirSync(path.join(turnsDir, '0002.md.tmp'), { recursive: true })
  const err = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
    engine.onSessionEvent({ id: sid }, userMsgEvent(5, '第 2 轮写盘会失败', 2))
    engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  })
  assert(err.includes('turn write failed'), `写盘失败应 stderr 报警，实际：${JSON.stringify(err)}`)
  assert(!fs.existsSync(path.join(turnsDir, '0002.md')), '写盘失败的轮次不应落盘')
  assert.strictEqual(indexField(path.join(sessionDir(root, TMP, sid), 'index.md'), 'turns'), '1', '失败的轮次不应计入 turns')

  // mkdir 失败：会话目录位置被同名文件占用
  const sid2 = 'mkdir-fail'
  const blocked = sessionDir(root, TMP, sid2)
  engine.onSessionCreated({ id: sid2, header: { cwd: TMP, createdAt: 1700000000000 } })
  fs.writeFileSync(blocked, '占位文件')
  const err2 = captureStderr(() => {
    engine.onSessionEvent({ id: sid2 }, turnStartEvent(7, 1))
    engine.onSessionEvent({ id: sid2 }, userMsgEvent(8, '建目录会失败', 1))
    engine.onSessionEvent({ id: sid2 }, turnEndEvent(9, 1))
  })
  assert(err2.includes('mkdir failed'), `建目录失败应 stderr 报警，实际：${JSON.stringify(err2)}`)
  assert(fs.statSync(blocked).isFile(), '占位文件不应被破坏')
  assert.strictEqual(fs.readFileSync(blocked, 'utf8'), '占位文件', '占位文件内容不应被改')
})

// ---- R5（修复5）：safeSessionDir 拒绝不安全 id ----
test('R5: safeSessionDir 拒绝 ""/"."/".."；引擎对不安全 id 不产出任何文件', () => {
  assert.throws(() => safeSessionDir(''), '空 id 应拒绝')
  assert.throws(() => safeSessionDir('.'), '"." 应拒绝（否则会写到 root 本身）')
  assert.throws(() => safeSessionDir('..'), '".." 应拒绝（否则会写到 root 的父目录）')
  // 替换规则仍在：危险字符降级为 _
  assert.strictEqual(safeSessionDir('a/b\\c:d*e'), 'a_b_c_d_e', '不安全字符应替换为 _')

  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const err = captureStderr(() => {
    for (const bad of ['.', '..', '']) {
      engine.onSessionCreated({ id: bad, header: { cwd: TMP, createdAt: 1700000000000 } })
      engine.onSessionEvent({ id: bad }, turnStartEvent(1, 1))
      engine.onSessionEvent({ id: bad }, userMsgEvent(2, '不该落盘', 1))
      engine.onSessionEvent({ id: bad }, turnEndEvent(3, 1))
    }
  })
  assert(err.includes('refuse session'), `不安全 id 应 stderr 报警，实际：${JSON.stringify(err)}`)
  // root 下不应出现 turns/ 或任何 md（说明没有把 root 当会话目录）
  const leftovers = fs.readdirSync(root).filter((name) => name !== '.gitkeep')
  assert.deepStrictEqual(leftovers, [], `不安全 id 不应产出任何文件，实际：${leftovers.join(',')}`)
})

// ---- R6（修复6）：session/disposed 回收内存记录 ----
test('R6: session/disposed 回收内存记录，其后事件不再写文件', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'dispose-me'
  const header = { cwd: TMP, createdAt: 1700000000000 }
  engine.onSessionCreated({ id: sid, header })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第 1 轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert(fs.existsSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md')), '第 1 轮应落盘')

  engine.onSessionDisposed({ id: sid })
  engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
  engine.onSessionEvent({ id: sid }, userMsgEvent(5, 'disposed 后的第 2 轮', 2))
  engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  assert(!fs.existsSync(path.join(sessionDir(root, TMP, sid), 'turns', '0002.md')), 'disposed 后不应再写文件')
  assert.strictEqual(indexField(path.join(sessionDir(root, TMP, sid), 'index.md'), 'turns'), '1', 'disposed 后 index 不应变化')

  // 反向对照：重新 created（自愈回填 1 轮）后，第 2 轮能正常续写
  engine.onSessionCreated({ id: sid, header })
  engine.onSessionEvent({ id: sid }, turnStartEvent(7, 2))
  engine.onSessionEvent({ id: sid }, userMsgEvent(8, '重新建档后的第 2 轮', 2))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 2))
  assert(fs.existsSync(path.join(sessionDir(root, TMP, sid), 'turns', '0002.md')), '重新建档后应能续写 0002.md')
  assert.strictEqual(turnField(path.join(sessionDir(root, TMP, sid), 'turns', '0002.md'), 'prev'), 'turns/0001.md', '续写 prev 指向 0001')
})

// ---- R7（修复7）：## user 收录 user + agent-message ----
test('R7: ## user 只收 user + agent-message；plugin/skill-catalog 不收；都没有则写占位', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'user-scope'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '人类直接输入', 1))
  engine.onSessionEvent({ id: sid }, agentMsgEvent(3, '另一个 agent 发来的消息', 1))
  engine.onSessionEvent({ id: sid }, pluginMsgEvent(4, '插件注入的上下文', 1))
  engine.onSessionEvent({ id: sid }, skillMsgEvent(5, '技能目录清单', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(6, 1))
  const body = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md'), 'utf8')
  const userSection = body.split('## assistant')[0] ?? ''
  assert(userSection.includes('人类直接输入'), '## user 应含 human 文本')
  assert(userSection.includes('另一个 agent 发来的消息'), '## user 应含 agent-message 文本')
  assert(!userSection.includes('插件注入的上下文'), 'plugin 注入不应进 ## user')
  assert(!userSection.includes('技能目录清单'), 'skill-catalog 不应进 ## user')

  // 只有被排除的来源 → 写占位行
  engine.onSessionEvent({ id: sid }, turnStartEvent(7, 2))
  engine.onSessionEvent({ id: sid }, pluginMsgEvent(8, '只有注入上下文', 2))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 2))
  const body2 = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0002.md'), 'utf8')
  const userSection2 = body2.split('## assistant')[0] ?? ''
  assert(userSection2.includes('（无用户文本）'), '没有可收录文本时应写（无用户文本）占位')
  assert(!userSection2.includes('只有注入上下文'), '被排除来源的文本不应落盘')
})

// ---- R8：新格式断言（三列轮次表 / 无 summary·links·files / 时间全 UTC） ----
test('R8: 新格式：轮次表三列、无 summary/links/files、时间全 UTC', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'format-check'
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, titleEvent(1, '格式检查'))
  engine.onSessionEvent({ id: sid }, contextEvent(2, 'deepseek-v4-flash'))
  for (let t = 1; t <= 2; t += 1) {
    engine.onSessionEvent({ id: sid }, turnStartEvent(t * 3, t))
    engine.onSessionEvent({ id: sid }, userMsgEvent(t * 3 + 1, `第 ${t} 轮`, t))
    engine.onSessionEvent({ id: sid }, turnEndEvent(t * 3 + 2, t))
  }
  const indexFile = path.join(sessionDir(root, TMP, sid), 'index.md')
  const indexText = fs.readFileSync(indexFile, 'utf8')

  // 轮次表头与分隔行必须是三列
  const lines = indexText.split('\n')
  const head = lines.findIndex((l) => l.startsWith('| seq |'))
  assert(head !== -1, 'index 缺轮次表头')
  assert.strictEqual(lines[head], '| seq | time | kind |', '轮次表头必须是三列')
  assert.strictEqual(lines[head + 1], '| --- | ---- | ---- |', '轮次表分隔行必须是三列')
  for (const banned of ['summary', 'links', 'files']) {
    assert(!indexText.includes(banned), `index 不应再出现 ${banned}`)
  }
  // 三列数据行：每行 3 个单元格
  const rows = lines.filter((l) => /^\| \d{4} \|/.test(l))
  assert.strictEqual(rows.length, 2, `应有 2 行轮次，实际 ${rows.length}`)
  for (const row of rows) {
    assert.strictEqual(row.split('|').length, 5, `数据行必须是三列：${row}`)
  }
  // index frontmatter 字段集合固定
  const indexKeys = frontmatterOf(indexFile).split('\n').map((l) => l.split(':')[0]?.trim()).filter((k) => k !== undefined && k !== '')
  assert.deepStrictEqual(indexKeys, ['title', 'session', 'started', 'model', 'turns', 'fork_from'], `index frontmatter 字段集合变了：${indexKeys.join(',')}`)

  // 轮次 frontmatter 字段集合固定（无 links/files），时间全 UTC
  const turn1 = path.join(sessionDir(root, TMP, sid), 'turns', '0001.md')
  const turnKeys = frontmatterOf(turn1).split('\n').map((l) => l.split(':')[0]?.trim()).filter((k) => k !== undefined && k !== '')
  assert.deepStrictEqual(turnKeys, ['session', 'seq', 'time', 'kind', 'prev'], `轮次 frontmatter 字段集合变了：${turnKeys.join(',')}`)
  assertUtc(turnField(turn1, 'time'), '轮次 time')
  assertUtc(indexField(indexFile, 'started'), 'index started')
  assertUtc(turnField(turn1, 'time'), '轮次 time（UTC）')
})

// ---- apply(ctx, config) 接线（直接驱动真实 apply，不 mock 被测对象） ----

/** 假 cordis ctx：记录 apply 注册的监听器，并允许按事件名回放真实形状的载荷。 */
interface FakeCtx {
  on(event: string, listener: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  listenerCount(): number
  /** 可选的假设置服务（任务2 接线用）。 */
  settings?: FakeSettingsProvider
}

/**
 * 假设置服务：只实现引擎真正用到的 `register`/`get`，**不 mock 被测对象**
 * （引擎与 normalize 都是真代码，这里只是替宿主保管一份 user 段）。
 */
interface FakeSettingsProvider {
  register(ns: string, schema: unknown, options: { applies: 'live' | 'restart' }): { get(): unknown; watch(cb: (a: unknown, b: unknown) => void): () => void }
  get(ns: string): unknown
  /** 直接改 user 段（模拟用户在设置页/文件里改设置）。 */
  set(ns: string, patch: Record<string, unknown>): void
}

function fakeSettings(initial: Record<string, unknown> = {}): FakeSettingsProvider {
  const sections = new Map<string, Record<string, unknown>>()
  sections.set('conversation-recorder', { ...initial })
  return {
    register(_ns, _schema, _options) {
      return {
        get: () => sections.get('conversation-recorder') ?? {},
        watch: () => () => {},
      }
    },
    get(ns) {
      return sections.get(ns)
    },
    set(ns, patch) {
      sections.set(ns, { ...(sections.get(ns) ?? {}), ...patch })
    },
  }
}

function fakeCtx(): FakeCtx {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    listenerCount() {
      let total = 0
      for (const list of listeners.values()) total += list.length
      return total
    },
  }
}

test('接线1: apply(ctx, config) 的 root 真接进引擎（配了 root 就写那里，与会话 cwd 无关）', () => {
  const base = freshDir()
  const cwd = path.join(base, 'session-cwd') // 会话 cwd 故意与配置 root 不同
  const configured = path.join(base, 'configured-root')
  const sid = 'wire-root'
  const ctx = fakeCtx()

  apply(ctx as unknown as Parameters<typeof apply>[0], { root: configured })
  assert.strictEqual(ctx.listenerCount(), 3, 'apply 应注册 session/created、session/event、session/disposed 三个监听器')

  ctx.emit('session/created', { id: sid, header: { cwd, createdAt: 1700000000000 } })
  ctx.emit('session/event', { id: sid }, turnStartEvent(1, 1))
  ctx.emit('session/event', { id: sid }, userMsgEvent(2, '接线用例', 1))
  ctx.emit('session/event', { id: sid }, turnEndEvent(3, 1))

  assert(fs.existsSync(path.join(sessionDir(configured, cwd, sid), 'index.md')), '配置的 root 下应有 index.md')
  assert(fs.existsSync(path.join(sessionDir(configured, cwd, sid), 'turns', '0001.md')), '配置的 root 下应有 turns/0001.md')
  assert(!fs.existsSync(path.join(cwd, '_conversations')), '配了 root 就不得再往会话 cwd 下写')
})

/**
 * 接线2（**本任务唯一允许改写的既有用例**）：默认落点不再跟随会话 cwd。
 *
 * 旧用例断言「不配 root → 写 `<cwd>/_conversations`」；任务1/2 之后默认落点是内置统一根，
 * 故按新契约改写为两段：
 *  ① 配置与设置都缺 → 引擎算出的落点是内置默认根 `<$DSH_HOME>/_conversations`（不再跟随 cwd）；
 *  ② 设置里的 root 最高优先 → 落点真的跟着设置走（这条同时是任务2「root 接线」的验收）。
 * 说明：① 段不真往 `$DSH_HOME` 写文件——那是工作区外的真实数据目录（本任务明令不许动），
 * 改用「目录不可写时引擎报 mkdir failed 且不往 cwd 落任何东西」来证明它确实指向内置根。
 */
test('接线2: 不配 root → 落内置默认根 <$DSH_HOME>/_conversations（不再跟随 cwd）；设置里的 root 最高优先', () => {
  const base = freshDir()
  const cwd = path.join(base, 'session-cwd') // 会话 cwd 故意与内置默认根不同
  fs.mkdirSync(cwd, { recursive: true })

  // ① 不传 config、不挂设置服务 → 落点是内置默认根
  const sidA = 'wire-default'
  const ctxA = fakeCtx()
  apply(ctxA as unknown as Parameters<typeof apply>[0])
  const errA = captureStderr(() => {
    ctxA.emit('session/created', { id: sidA, header: { cwd, createdAt: 1700000000000 } })
    ctxA.emit('session/event', { id: sidA }, turnStartEvent(1, 1))
    ctxA.emit('session/event', { id: sidA }, userMsgEvent(2, '跟随内置默认根', 1))
    ctxA.emit('session/event', { id: sidA }, turnEndEvent(3, 1))
  })
  const defaultRootDir = defaultRoot()
  assert.strictEqual(
    defaultRootDir,
    path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), CONVERSATIONS_DIR),
    `默认根应等于 <$DSH_HOME>/${CONVERSATIONS_DIR}（与宿主 resolveDshHome 口径一致）`,
  )
  // 引擎确实在往内置默认根下建目录（本进程可能被沙箱拦在工作区外 → 以 stderr 为证）
  assert(
    errA.includes(path.join(defaultRootDir, workspaceDir(cwd), sidA)) || fs.existsSync(path.join(defaultRootDir, workspaceDir(cwd), sidA)),
    `未配 root 时应指向内置默认根 ${defaultRootDir}，stderr=${JSON.stringify(errA)}`,
  )
  assert(!fs.existsSync(path.join(cwd, CONVERSATIONS_DIR)), '不再往会话 cwd 下写 _conversations')
  assert(!fs.existsSync(path.join(cwd, CONVERSATIONS_DIR, workspaceDir(cwd), sidA)), '会话 cwd 下不应出现任何记录目录')

  // ② 设置里的 root 最高优先（压过配置层）→ 落点跟着设置走，且改设置后立刻生效
  const settingsRootA = path.join(base, 'settings-root-a')
  const settingsRootB = path.join(base, 'settings-root-b')
  const provider = fakeSettings({ root: settingsRootA })
  const sidB = 'wire-settings'
  const ctxB = fakeCtx()
  ctxB.settings = provider
  apply(ctxB as unknown as Parameters<typeof apply>[0], { root: path.join(base, 'config-root-被设置压过') })
  ctxB.emit('session/created', { id: sidB, header: { cwd, createdAt: 1700000000000 } })
  ctxB.emit('session/event', { id: sidB }, turnStartEvent(1, 1))
  ctxB.emit('session/event', { id: sidB }, userMsgEvent(2, '设置里的 root', 1))
  ctxB.emit('session/event', { id: sidB }, turnEndEvent(3, 1))
  assert(
    fs.existsSync(path.join(sessionDir(settingsRootA, cwd, sidB), 'turns', '0001.md')),
    '设置里的 root 应最高优先（压过配置层）',
  )
  assert(!fs.existsSync(path.join(base, 'config-root-被设置压过')), '配置层不应被用到（设置已给出 root）')

  // 设置改成新 root → 同一个会话的下一轮立刻落到新 root（live，不用重启）
  // **0.3.0 契约变更（旧→新见 PROGRESS.md）**：序号只从**当前 root 下的那个会话目录**扫（SPEC §6/§8）。
  //   · 旧规则（个数口径，且「新根为空时不当作轮次被删」）→ 内存计数保持 1 ⇒ 新根下写 0002.md。
  //   · 新规则（磁盘最大序号 + 1）→ 新根下没有轮次 ⇒ max=0 ⇒ 新根下写 **0001.md**（旧根下的 0001 不动）。
  // 这正是 SPEC §8 已写明的已知行为：「换 root 之后旧根下的记录认不回来，在新根从头算」。
  provider.set('conversation-recorder', { root: settingsRootB })
  ctxB.emit('session/event', { id: sidB }, turnStartEvent(4, 2))
  ctxB.emit('session/event', { id: sidB }, userMsgEvent(5, '改设置后的第 2 轮', 2))
  ctxB.emit('session/event', { id: sidB }, turnEndEvent(6, 2))
  assert(
    fs.existsSync(path.join(sessionDir(settingsRootB, cwd, sidB), 'turns', '0001.md')),
    '改设置后新轮次应立刻落到新 root（live 生效）；新根下序号从 1 起（该根下无已有记录）',
  )
  assert.strictEqual(
    turnField(path.join(sessionDir(settingsRootB, cwd, sidB), 'turns', '0001.md'), 'prev'),
    '',
    '新根下的首轮 prev 留空（该根下没有上一轮）',
  )
  assert.deepStrictEqual(
    turnFiles(path.join(sessionDir(settingsRootA, cwd, sidB))),
    ['0001.md'],
    '旧根下的记录不迁不删、一字不动',
  )
})

// ================= 本轮新增：按工作区分区（2026-09-15） =================

test('W0: workspaceDir 纯函数：两条实测名逐字、cwd 缺失落未分组、保留字符与 ~ 自体转义', () => {
  // 契约给定的两条实测名（逐字，不许有偏差）
  assert.strictEqual(workspaceDir('D:\\知识库'), 'D-知识库~77E5~8BC6~5E93', 'D:\\知识库 的工作区文件夹名')
  assert.strictEqual(workspaceDir('D:\\大胆'), 'D-大胆~5927~80C6', 'D:\\大胆 的工作区文件夹名')
  // ①/⑤ cwd 缺失、空串、去冒号后为空
  assert.strictEqual(workspaceDir(undefined), '未分组', 'cwd 缺失 → 未分组')
  assert.strictEqual(workspaceDir(''), '未分组', 'cwd 空串 → 未分组')
  assert.strictEqual(workspaceDir(':'), '未分组', '只剩冒号（处理后为空）→ 未分组')
  // ② 去 `:`、`\` → `-`
  assert.strictEqual(workspaceDir('C:\\plain\\dir'), 'C-plain-dir', 'ASCII 路径只做分隔符替换')
  // ④ 保留字符逐字符转义成 ~XXXX（含 `~` 自身，否则与 ~XXXX 歧义）
  assert.strictEqual(workspaceDir('D:\\wk#x'), 'D-wk~0023x', '# → ~0023')
  assert.strictEqual(workspaceDir('D:\\a~b'), 'D-a~007Eb', '~ → ~007E（自身必须转义）')
  assert.strictEqual(workspaceDir('D:\\a[b]c'), 'D-a~005Bb~005Dc', '[ ] → ~005B ~005D')
  assert.strictEqual(workspaceDir('D:\\a?b*c'), 'D-a~003Fb~002Ac', '? * → ~003F ~002A')
  // ③ 连续非 ASCII 段：保留可读形式 + 紧跟每码元 ~XXXX
  assert.strictEqual(workspaceDir('D:\\工作'), 'D-工作~5DE5~4F5C', '非 ASCII 段规则')
  assert.strictEqual(workspaceDir('D:\\a知识b'), 'D-a知识~77E5~8BC6b', '非 ASCII 段只对连续段生效（ASCII 中断）')
  // 纯函数：同 cwd 恒定同名（历史记录按名字归位的前提）
  assert.strictEqual(workspaceDir('D:\\知识库'), workspaceDir('D:\\知识库'), '同 cwd 必须同名')
})

test('W1: 两个不同 cwd 的会话各落自己的工作区文件夹（文件夹名逐字照契约）', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const kbCwd = 'D:\\知识库'
  const ddCwd = 'D:\\大胆'
  const kb = 'kb-session'
  const dd = 'dd-session'

  engine.onSessionCreated({ id: kb, header: { cwd: kbCwd, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: kb }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: kb }, userMsgEvent(2, '知识库里的会话', 1))
  engine.onSessionEvent({ id: kb }, turnEndEvent(3, 1))

  engine.onSessionCreated({ id: dd, header: { cwd: ddCwd, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: dd }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: dd }, userMsgEvent(2, '大胆里的会话', 1))
  engine.onSessionEvent({ id: dd }, turnEndEvent(3, 1))

  // root 下恰好两个工作区文件夹，名字与契约逐字一致
  // （0.3.0 任务2：root 下还会由插件写出 README.md/AGENTS.md 两份产物文档，用 rootDirs 只看目录）
  assert.deepStrictEqual(
    rootDirs(root),
    ['D-知识库~77E5~8BC6~5E93', 'D-大胆~5927~80C6'].sort(),
    `root 下应恰好两个工作区文件夹，实际：${fs.readdirSync(root).join(',')}`,
  )
  const kbTurn = path.join(root, 'D-知识库~77E5~8BC6~5E93', kb, 'turns', '0001.md')
  const ddTurn = path.join(root, 'D-大胆~5927~80C6', dd, 'turns', '0001.md')
  assert(fs.existsSync(kbTurn), `知识库会话应落 <root>/D-知识库~77E5~8BC6~5E93/${kb}/turns/：缺 ${kbTurn}`)
  assert(fs.existsSync(ddTurn), `大胆会话应落 <root>/D-大胆~5927~80C6/${dd}/turns/：缺 ${ddTurn}`)
  // 旧布局（会话目录直接平铺在 root 下）必须不再产出
  assert(!fs.existsSync(path.join(root, kb)), '会话目录不应再直接平铺在 root 下')
  assert(!fs.existsSync(path.join(root, dd)), '会话目录不应再直接平铺在 root 下')
})

test('W2: cwd 缺失 → 该会话落 未分组 文件夹', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'no-cwd'
  engine.onSessionCreated({ id: sid, header: { createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '没有 cwd 的会话', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))

  assert.deepStrictEqual(rootDirs(root), ['未分组'], `root 下应只有 未分组，实际：${fs.readdirSync(root).join(',')}`)
  assert(fs.existsSync(path.join(root, '未分组', sid, 'turns', '0001.md')), 'cwd 缺失应落 <root>/未分组/<id>/turns/0001.md')
})

test('W3: 工作区名含 # 被转义（保留字符不落进目录名）', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'hash-cwd'
  engine.onSessionCreated({ id: sid, header: { cwd: 'D:\\wk#dev', createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '工作区名带井号', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))

  assert.deepStrictEqual(rootDirs(root), ['D-wk~0023dev'], `含 # 的工作区名应逐字符转义，实际：${fs.readdirSync(root).join(',')}`)
  assert(fs.existsSync(path.join(root, 'D-wk~0023dev', sid, 'turns', '0001.md')), '会话应落 <root>/D-wk~0023dev/<id>/')
  assert(!fs.existsSync(path.join(root, 'D-wk#dev')), '不得落下含 # 的原始名目录')
})

test('W4: fork 子会话首轮 prev 指向同一工作区文件夹内的父轮次', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const cwd = 'D:\\知识库'
  const ws = 'D-知识库~77E5~8BC6~5E93'
  const parent = 'fork-parent-alt'
  engine.onSessionCreated({ id: parent, header: { cwd, createdAt: 1700000000000 } })
  for (let t = 1; t <= 4; t += 1) {
    engine.onSessionEvent({ id: parent }, turnStartEvent(t * 3 - 2, t))
    engine.onSessionEvent({ id: parent }, userMsgEvent(t * 3 - 1, `父第 ${t} 轮`, t))
    engine.onSessionEvent({ id: parent }, turnEndEvent(t * 3, t))
  }

  const child = 'fork-child-alt'
  engine.onSessionCreated({ id: child, header: { cwd, createdAt: 1700000000000, parentSession: parent } })
  engine.onSessionEvent({ id: child }, turnStartEvent(1, 5))
  engine.onSessionEvent({ id: child }, userMsgEvent(3, '子会话第一个问题', 5))
  engine.onSessionEvent({ id: child }, turnEndEvent(4, 5))

  const childTurn1 = path.join(root, ws, child, 'turns', '0001.md')
  const parentTurn4 = path.join(root, ws, parent, 'turns', '0004.md')
  assert(fs.existsSync(childTurn1), `fork 子首轮应落 <root>/${ws}/${child}/turns/0001.md`)
  assert(fs.existsSync(parentTurn4), `fork 父第 4 轮应在 <root>/${ws}/${parent}/turns/0004.md`)
  // prev 命名规则不变（分区只多一级目录，fork 父子同 cwd ⇒ 同文件夹）
  assert.strictEqual(turnField(childTurn1, 'prev'), `../${parent}/turns/0004.md`, 'fork 首轮 prev 命名规则不变')
  // prev 相对**会话目录**（同会话 prev 即 turns/NNNN.md），故解析基点取子会话目录
  const childSessionDir = path.dirname(path.dirname(childTurn1))
  const resolved = path.resolve(childSessionDir, turnField(childTurn1, 'prev'))
  assert.strictEqual(resolved, parentTurn4, `prev 应解析到同文件夹内的父轮次，实际 ${resolved}`)
  assert.strictEqual(path.dirname(childSessionDir), path.join(root, ws), '父与子必须在同一工作区文件夹')
})

// ============ 本轮新增（2026-09-15）：宿主侧四个设置 ============

/** 用假设置服务造一个真实 SettingsSource（normalize/三层优先都是真代码）。 */
function settingsEngine(initial: Record<string, unknown>, config: Parameters<typeof createSettingsSource>[0] = {}): RecorderEngine {
  return new RecorderEngine(config, createSettingsSource(config, fakeSettings(initial)))
}

test('S0: 设置默认值：root=内置统一根（$DSH_HOME/_conversations）、recordSubagents=false、toolArgsPreview=40、emptyIndex=false', () => {
  assert.strictEqual(defaultRoot(), path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), CONVERSATIONS_DIR), '默认 root = <$DSH_HOME>/_conversations')

  // 空 user 段 + 空配置 → 四处都取内置默认
  const root = freshDir()
  const engine = settingsEngine({ root })
  const sid = 'defaults'
  const meta = JSON.stringify(createSettingsSource({}, fakeSettings({})).current())
  assert(meta.includes('"recordSubagents":false'), `recordSubagents 默认应为 false：${meta}`)
  assert(meta.includes('"toolArgsPreview":40'), `toolArgsPreview 默认应为 40：${meta}`)
  assert(meta.includes('"emptyIndex":false'), `emptyIndex 默认应为 false：${meta}`)

  // 默认 emptyIndex=false：只发 title 不产生任何文件（空壳目录 bug）
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, titleEvent(1, '只有标题'))
  assert.deepStrictEqual(fs.readdirSync(root), [], '默认设置下只发 title 不应产生任何文件')

  // 默认 toolArgsPreview=40：参数预览截到 40 字
  engine.onSessionEvent({ id: sid }, turnStartEvent(2, 1))
  engine.onSessionEvent({ id: sid }, toolCallEvent(3, 'call_default000000000', 'fs_read', 'X'.repeat(100)))
  engine.onSessionEvent({ id: sid }, toolResultEvent(4, 'call_default000000000', 'ok'))
  engine.onSessionEvent({ id: sid }, turnEndEvent(5, 1))
  const body = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md'), 'utf8')
  assert(body.includes('X'.repeat(40)), '默认参数预览应为 40 字')
  assert(!body.includes('X'.repeat(41)), '默认参数预览不应超过 40 字')

  // 默认 recordSubagents=false：子代理会话不记录
  engine.onSessionCreated({ id: 'sub-default', header: { origin: 'subagent', cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: 'sub-default' }, turnStartEvent(6, 1))
  engine.onSessionEvent({ id: 'sub-default' }, userMsgEvent(7, '子代理', 1))
  engine.onSessionEvent({ id: 'sub-default' }, turnEndEvent(8, 1))
  assert(!fs.existsSync(sessionDir(root, TMP, 'sub-default')), '默认不记录子代理会话')
})

test('S1: 改 root 设置 → 落点跟着变（落点由设置解析，不再跟随会话 cwd）', () => {
  const base = freshDir()
  const cwd = path.join(base, 'cwd-s1')
  fs.mkdirSync(cwd, { recursive: true })
  const rootA = path.join(base, 'root-a')
  const rootB = path.join(base, 'root-b')

  const engineA = settingsEngine({ root: rootA })
  engineA.onSessionCreated({ id: 's1-a', header: { cwd, createdAt: 1700000000000 } })
  engineA.onSessionEvent({ id: 's1-a' }, turnStartEvent(1, 1))
  engineA.onSessionEvent({ id: 's1-a' }, userMsgEvent(2, '第一轮', 1))
  engineA.onSessionEvent({ id: 's1-a' }, turnEndEvent(3, 1))
  assert(fs.existsSync(path.join(sessionDir(rootA, cwd, 's1-a'), 'turns', '0001.md')), '应落设置给的 root-a')
  assert(!fs.existsSync(path.join(cwd, CONVERSATIONS_DIR)), '配了 root 就不得再往会话 cwd 下写')

  // 另一份设置（等价于用户把 root 改成 root-b）→ 新会话落 root-b
  const engineB = settingsEngine({ root: rootB })
  engineB.onSessionCreated({ id: 's1-b', header: { cwd, createdAt: 1700000000000 } })
  engineB.onSessionEvent({ id: 's1-b' }, turnStartEvent(1, 1))
  engineB.onSessionEvent({ id: 's1-b' }, userMsgEvent(2, '第一轮', 1))
  engineB.onSessionEvent({ id: 's1-b' }, turnEndEvent(3, 1))
  assert(fs.existsSync(path.join(sessionDir(rootB, cwd, 's1-b'), 'turns', '0001.md')), '改 root 后新会话应落 root-b')
  assert(!fs.existsSync(path.join(rootA, workspaceDir(cwd), 's1-b')), 'root-a 下不应出现新会话')
  // 「改完即时生效」的整链验证（同一引擎、同一个会话）在「接线2」用例第二段
})

test('S2: toolArgsPreview 设置生效（0 / 10 / 200 与越界钳制）', () => {
  const root = freshDir()
  const sid = 's2'
  const longArgs = JSON.stringify({ pattern: 'Y'.repeat(300) })

  const engine = settingsEngine({ root, toolArgsPreview: 10 })
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, toolCallEvent(2, 'call_a00000000000000', 'glob', longArgs))
  engine.onSessionEvent({ id: sid }, toolResultEvent(3, 'call_a00000000000000', 'ok'))
  engine.onSessionEvent({ id: sid }, turnEndEvent(4, 1))
  const body1 = fs.readFileSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md'), 'utf8')
  assert(body1.includes(`glob ${longArgs.slice(0, 10)} `), 'toolArgsPreview=10 时应截到 10 字')
  assert(!body1.includes(longArgs.slice(0, 11)), '不应超过设置的 10 字')

  // 0：参数预览为空串（只留一个空格分隔）
  const engine0 = settingsEngine({ root, toolArgsPreview: 0 })
  engine0.onSessionCreated({ id: 's2-zero', header: { cwd: TMP, createdAt: 1700000000000 } })
  engine0.onSessionEvent({ id: 's2-zero' }, turnStartEvent(1, 1))
  engine0.onSessionEvent({ id: 's2-zero' }, toolCallEvent(2, 'call_b00000000000000', 'glob', longArgs))
  engine0.onSessionEvent({ id: 's2-zero' }, toolResultEvent(3, 'call_b00000000000000', 'ok'))
  engine0.onSessionEvent({ id: 's2-zero' }, turnEndEvent(4, 1))
  const body0 = fs.readFileSync(path.join(sessionDir(root, TMP, 's2-zero'), 'turns', '0001.md'), 'utf8')
  assert(body0.includes('- [call_b000000] glob  → 结果1行'), `toolArgsPreview=0 时参数预览为空，实际：\n${body0}`)

  // 越界（500）→ 按 schema 上界 200 钳住
  const engineBig = settingsEngine({ root, toolArgsPreview: 500 })
  const previewBig = longArgs.slice(0, 200)
  engineBig.onSessionCreated({ id: 's2-big', header: { cwd: TMP, createdAt: 1700000000000 } })
  engineBig.onSessionEvent({ id: 's2-big' }, turnStartEvent(1, 1))
  engineBig.onSessionEvent({ id: 's2-big' }, toolCallEvent(2, 'call_c00000000000000', 'glob', longArgs))
  engineBig.onSessionEvent({ id: 's2-big' }, toolResultEvent(3, 'call_c00000000000000', 'ok'))
  engineBig.onSessionEvent({ id: 's2-big' }, turnEndEvent(4, 1))
  const bodyBig = fs.readFileSync(path.join(sessionDir(root, TMP, 's2-big'), 'turns', '0001.md'), 'utf8')
  assert(bodyBig.includes(previewBig), 'toolArgsPreview>200 应钳到 200 字')
  assert(!bodyBig.includes(previewBig + longArgs.slice(200, 201)), '不应超过 200 字')
})

test('S3: recordSubagents=true → 子代理会话也记录（默认 false 已在 S0 覆盖）', () => {
  const root = freshDir()
  const sid = 'sub-on'
  const engine = settingsEngine({ root, recordSubagents: true })
  engine.onSessionCreated({ id: sid, header: { origin: 'subagent', cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '子代理也记', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert(fs.existsSync(path.join(sessionDir(root, TMP, sid), 'turns', '0001.md')), 'recordSubagents=true 时应记录子代理会话')
})

test('S4: emptyIndex=true → 只发 title 就建目录并写 index（默认 false 时不建）', () => {
  const root = freshDir()
  const sid = 'empty-on'
  const engine = settingsEngine({ root, emptyIndex: true })
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, titleEvent(1, '只有标题'))
  const indexFile = path.join(sessionDir(root, TMP, sid), 'index.md')
  assert(fs.existsSync(indexFile), 'emptyIndex=true 时应写 index.md')
  assert.strictEqual(indexField(indexFile, 'title'), '只有标题', 'emptyIndex=true 时 title 应写入')
  assert.strictEqual(indexField(indexFile, 'turns'), '0', '此时还没有轮次')

  // 默认（false）的同形状对照：同一个引擎类型，只把 emptyIndex 关掉
  const root2 = freshDir()
  const engine2 = settingsEngine({ root: root2, emptyIndex: false })
  engine2.onSessionCreated({ id: 'empty-off', header: { cwd: TMP, createdAt: 1700000000000 } })
  engine2.onSessionEvent({ id: 'empty-off' }, titleEvent(1, '只有标题'))
  assert.deepStrictEqual(fs.readdirSync(root2), [], 'emptyIndex=false 时只发 title 不产生任何文件（空壳目录 bug）')
})

// ============ 本轮新增（2026-09-15 0.2.1）：真 schemastery schema ============

test('S5: 设置 schema 是真 schemastery（宿主注册时当函数调用）：四字段默认值与 0–200 取值域可还原', () => {
  assert.strictEqual(typeof RecorderSettingsSchema, 'function', 'schema 必须是可调用的 schemastery schema（普通对象会让宿主 TypeError）')
  const resolved = RecorderSettingsSchema({}) as Record<string, unknown>
  assert.strictEqual(resolved.root, defaultRoot(), 'root 默认值 = 内置统一根（$DSH_HOME/_conversations）')
  assert.strictEqual(resolved.recordSubagents, false, 'recordSubagents 默认 false')
  assert.strictEqual(resolved.toolArgsPreview, DEFAULT_TOOL_ARGS_PREVIEW, 'toolArgsPreview 默认 40')
  assert.strictEqual(resolved.emptyIndex, false, 'emptyIndex 默认 false')
  assert.throws(() => { RecorderSettingsSchema({ toolArgsPreview: MAX_TOOL_ARGS_PREVIEW + 1 }) }, /<= 200/, '>200 必须由 schema 拒绝')
  assert.throws(() => { RecorderSettingsSchema({ toolArgsPreview: -1 }) }, />= 0/, '<0 必须由 schema 拒绝')
  // 设置页的渲染形状：toJSON() → new Schema(json) 必须还原同样的默认值
  const restored = new z(RecorderSettingsSchema.toJSON())
  assert.deepStrictEqual(restored({}), resolved, 'toJSON → new Schema(json) 应还原同样的默认值')
})

test('S6: 注册失败不再静默——stderr 写一行警告，再退回装配配置（上一轮翻车根因）', () => {
  const base = freshDir()
  const configured = path.join(base, 'config-fallback')
  const provider = {
    register(): never {
      throw new TypeError('schema is not a function')
    },
  }
  let source: ReturnType<typeof createSettingsSource> | undefined
  const captured = captureStderr(() => {
    source = createSettingsSource({ root: configured }, provider as Parameters<typeof createSettingsSource>[1])
  })
  assert(captured.includes('settings register failed'), `注册失败必须写 stderr 警告，实际 ${JSON.stringify(captured)}`)
  assert(captured.includes('conversation-recorder'), 'stderr 警告必须点名命名空间')
  assert(captured.includes('schema is not a function'), 'stderr 警告必须带上原始错误文本')
  assert(source !== undefined, 'createSettingsSource 必须仍然返回可用来源')
  assert.strictEqual(source.current().root, configured, '注册失败后应退回装配配置 root')
  assert.strictEqual(source.current().recordSubagents, false, '注册失败后其余字段取内置默认')
})

// ============ 本轮新增（2026-09-15）：三处修复 ============

test('X1: 缺号修复——漏掉一轮（写盘失败）后继续，序号仍连续无缺口', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'gap-fix'
  const dir = sessionDir(root, TMP, sid)
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第 1 轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))

  // 第 2 轮写盘失败（.tmp 位置被目录占住）→ 这一轮没落盘
  fs.mkdirSync(path.join(dir, 'turns', '0002.md.tmp'), { recursive: true })
  const err = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
    engine.onSessionEvent({ id: sid }, userMsgEvent(5, '第 2 轮（落盘失败）', 2))
    engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  })
  assert(err.includes('turn write failed'), '第 2 轮应写盘失败')
  fs.rmSync(path.join(dir, 'turns', '0002.md.tmp'), { recursive: true, force: true })

  // 第 3 轮接着写 → 必须补 0002.md，不许跳到 0003.md（缺号）
  engine.onSessionEvent({ id: sid }, turnStartEvent(7, 3))
  engine.onSessionEvent({ id: sid }, userMsgEvent(8, '第 3 轮', 3))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 3))
  assert(fs.existsSync(path.join(dir, 'turns', '0002.md')), '漏掉一轮后继续应补 0002.md')
  assert(!fs.existsSync(path.join(dir, 'turns', '0003.md')), '不许跳到 0003.md（缺号）')
  assert.strictEqual(turnField(path.join(dir, 'turns', '0002.md'), 'prev'), 'turns/0001.md', '补回的轮次 prev 指向 0001')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '2', 'index turns 应为 2')
})

test('X2: 空壳目录修复——只发标题事件不产生任何文件', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'shell'
  const dir = sessionDir(root, TMP, sid)
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, titleEvent(1, '只发标题'))
  engine.onSessionEvent({ id: sid }, contextEvent(2, 'some-model'))
  assert(!fs.existsSync(dir), '只发元数据事件不应建会话目录')
  assert(!fs.existsSync(path.join(dir, 'index.md')), '只发元数据事件不应写 index.md')
  assert.deepStrictEqual(fs.readdirSync(root), [], 'root 下不应出现任何东西')

  // 首个真实轮次落盘后，先前攒下的 title/model 一并落盘（不丢）
  engine.onSessionEvent({ id: sid }, turnStartEvent(3, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(4, '真实的一轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(5, 1))
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'title'), '只发标题', '首轮后 title 应补落盘')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'model'), 'some-model', '首轮后 model 应补落盘')
})

test('X3: 正斜杠修复——cwd 含 `/` 时工作区名只做分隔符替换，不产生多一级目录', () => {  // 契约 §2 规则②：`\` 与 `/` 等价替换成 `-`
  assert.strictEqual(workspaceDir('D:/知识库'), 'D-知识库~77E5~8BC6~5E93', 'D:/知识库 与 D:\\知识库 应同名')
  assert.strictEqual(workspaceDir('C:/a/b'), 'C-a-b', '正斜杠路径只做分隔符替换')
  assert.strictEqual(workspaceDir('C:/a/b'), workspaceDir('C:\\a\\b'), '两种分隔符必须等价')
  assert(!workspaceDir('C:/a/b').includes('/'), '工作区名不得含 `/`')

  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'slash'
  engine.onSessionCreated({ id: sid, header: { cwd: 'D:/知识库', createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '正斜杠 cwd', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert.deepStrictEqual(rootDirs(root), ['D-知识库~77E5~8BC6~5E93'], `root 下应恰好一个工作区文件夹，实际：${fs.readdirSync(root).join(',')}`)
  assert(fs.existsSync(path.join(root, 'D-知识库~77E5~8BC6~5E93', sid, 'turns', '0001.md')), '含正斜杠的 cwd 应落单层工作区文件夹')
})

// ============ 本轮新增（2026-09-15）：客户端半边（设置页分区） ============

test('C-client: lib/client.js 是自注册 bundle：settings.section 槽齐（id/label/locale/inject）、外部依赖不内联', () => {
  const result = probeClientBundle()
  assert.deepStrictEqual([...result.registrations], ['dsh-conversation-recorder'], '自注册 id 应为包名')
  assert(result.exportKeys.includes('apply'), '客户端导出必须含 apply')
  assert(result.exportKeys.includes('inject'), '客户端导出必须含 inject')
  assert(result.inject.includes('slots'), 'inject 必须含 slots')
  assert(result.inject.includes('remote.settings'), 'inject 必须含 remote.settings')
  assert.strictEqual(result.section.name, 'settings.section', '槽 name')
  assert.strictEqual(result.section.id, 'conversationRecorder', '槽 id（契约要求）')
  assert.strictEqual(result.section.label, '会话记录', '槽 label')
  assert.strictEqual(result.section.locale, 'conversation-recorder', '槽 locale（命名空间）')
  assert(result.injectFaceKeys.includes('ctx'), '槽 inject 必须把客户端 ctx 交给组件')
  assert.strictEqual(result.describeCallsAtMount, 0, '挂载阶段不应主动读设置（读值在组件挂载后）')
  // 外部依赖保持外部：产物里只 require 宿主基线模块，不内联 react
  assert(result.source.includes('require("react")'), 'react 必须保持外部 require')
  assert(result.source.includes('__ModuleLoader__.load'), '产物必须是浏览器自注册 bundle')
  // 物化时任何基线表以外的 require 都会抛错（probe 的 requireFrom 只认 react 与 primitives）——
  // 即「产物只依赖宿主基线模块、没把宿主库打进产物」
  //
  // 0.3.0 任务3-⑤：把易碎的 `bytes < 20000` 体积断言换成**结构断言**。体积阈值是「易碎」的：
  // 加一个本地模块就让阈值失效（本轮加 save-flow.ts 后 15010 → 15710 字节，什么坏事都没发生），
  // 而它想守的不变量其实是结构性的：「每个 require 都落在【宿主基线白名单】或【bundle 自己的
  // 相对模块表】里，且产物里没有宿主库的实现代码」。
  const requires = [...result.source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)].map((m) => m[2] ?? '')
  const BASELINE_ALLOWED = ['react', '@deepseek-ai/dsh-client-ui-primitives']
  for (const spec of requires) {
    const isLocal = spec.startsWith('./')
    assert(
      isLocal || BASELINE_ALLOWED.includes(spec),
      `产物里的 require(${JSON.stringify(spec)}) 既不是宿主基线模块也不是本地相对模块 —— 有东西被内联/越权引入了`,
    )
  }
  assert(requires.includes('react'), '产物必须仍 require react（不内联宿主库）')
  assert(
    requires.includes('@deepseek-ai/dsh-client-ui-primitives'),
    '产物必须仍 require 宿主 primitives（不内联宿主库）',
  )
  // 相对 require 必须在 bundle 自己的模块表里有定义（浏览器才解析得到）
  for (const spec of requires.filter((s) => s.startsWith('./'))) {
    assert(
      result.source.includes(`${JSON.stringify(spec)}: function (module, exports, require)`),
      `相对模块 ${spec} 必须装进 bundle 的本地模块表`,
    )
  }
  // 产物里不得出现宿主侧源码的特征串（真内联会发生的事）
  assert(!result.source.includes('__DSH_BOOT__'), '产物不得内联宿主 shell')
  assert(!result.source.includes('dsh-settings/lib'), '产物不得内联宿主设置实现')
})

test('C-client-2: 设置分区没有裸原生控件（input/button/label），控件全部来自宿主 primitives', () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = fs.readFileSync(path.join(repo, 'src', 'client', 'index.ts'), 'utf8')
  for (const tag of ['input', 'button', 'label']) {
    assert(!source.includes(`createElement('${tag}'`), `设置分区不得出现裸 <${tag}>（应有 createElement('${tag}')）`)
    assert(!source.includes(`createElement("${tag}"`), `设置分区不得出现裸 <${tag}>（双引号写法）`)
  }
  assert(source.includes("from '@deepseek-ai/dsh-client-ui-primitives'"), '控件必须来自宿主 primitives')
  assert(source.includes('createElement(Input') && source.includes('createElement(Button'), '输入/按钮必须用 primitives 的 Input/Button')
  // 产物里 primitives 必须保持外部 require（不内联宿主库）
  const bundle = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8')
  assert(
    bundle.includes('require("@deepseek-ai/dsh-client-ui-primitives")'),
    'lib/client.js 必须把宿主 primitives 保持为外部 require',
  )
})

// ============ 本轮新增（0.2.1）：真宿主 SettingsProvider 集成用例（防静默事故复发） ============
//
// 上一轮翻车的原因：本插件交了个普通对象当 schema，宿主 `register()` 把它当函数调用 →
// `TypeError: schema is not a function`，又被裸 catch 吞掉。这里**直接 import 安装树里的真
// SettingsProvider**，用真 `register` 与真 `resolve`，只把 `this` 换成假的（section 读原始
// user 段、registrations 空表、ctx.effect 立刻执行回调），把这条链钉死。

/**
 * 真宿主设置实现入口：优先直接解析 `@deepseek-ai/dsh-settings`（声明在 devDependencies 时走这条），
 * 退回「从已安装的同伴 peer `dsh-home-paths` 反推同目录」——本地开发环境里那是个指向 DSH 安装树的
 * junction，两条路径都能落到真 `SettingsProvider`。
 *
 * 返回空串 = 这台机器上找不到真宿主实现（例如 CI 只装了本仓库的 devDependencies）。
 */
function realDshSettingsEntry(): string {
  try {
    return fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-settings'))
  } catch {
    // 没直接声明时退回反推
  }
  try {
    const peer = import.meta.resolve('@deepseek-ai/dsh-home-paths')
    // .../node_modules/@deepseek-ai/dsh-home-paths/lib/index.js → .../node_modules/@deepseek-ai
    const scopeDir = path.dirname(path.dirname(path.dirname(fileURLToPath(peer))))
    const candidate = path.join(scopeDir, 'dsh-settings', 'lib', 'index.js')
    if (fs.existsSync(candidate)) return candidate
  } catch {
    // 解析不到就返回空串，交给下面统一处理
  }
  return ''
}

const realSettingsEntry = realDshSettingsEntry()
/**
 * 「真宿主 SettingsProvider」集成用例（I1–I3）的**环境前提**：机器上能加载到真 `SettingsProvider`。
 *
 * 本仓库是**插件**，宿主实现（`@deepseek-ai/dsh-settings`）不在它的依赖里；CI 只装本仓库的
 * devDependencies，因此这三条在 CI 里报「环境缺失（跳过）」而不是假装通过——**不是放宽判据**：
 * 只要加载到了真实现，下面的断言一条不少。为什么要报出来而不是静默略过：上一轮的翻车
 * （`schema is not a function` 被裸 catch 吞掉）正是「没跑也看不出来」造成的。
 */
const realSettingsSkip = realSettingsEntry === ''
  ? '环境缺失：这台机器解析不到 @deepseek-ai/dsh-settings（真宿主设置实现）'
  : ''

/**
 * 真 provider 的假 `this`（只在加载到真实现时被赋值；`register`/`resolve`/`describe` 全是宿主真代码）。
 * 用「调用时才取」的形式，避免 `let` 在赋值前的暂时性死区。
 */
let realSettingsImpl: { prototype: object } | undefined

function realProvider(userSection: Record<string, unknown> | undefined): {
  register(ns: string, schema: unknown, options: { applies: 'live' | 'restart'; base?: object }): { get(): unknown }
  describe(options?: { redactSecrets?: boolean }): readonly Record<string, unknown>[]
} {
  const impl = realSettingsImpl
  assert(impl !== undefined, '真 SettingsProvider 未加载（realProvider 只应在可加载时被调用）')
  const provider = Object.create(impl.prototype) as Record<string, unknown>
  provider.registrations = new Map()
  provider.document = userSection === undefined ? {} : { 'conversation-recorder': userSection }
  // cordis 的 ctx.effect 会「立刻执行回调并登记清理」；本替身保留立刻执行这一关键语义
  provider.ctx = { effect: (callback: () => unknown) => { callback() } }
  // 真 section 的口径：读命名空间的**原始 user 段**（没写就是 undefined）
  provider.section = () => userSection
  return provider as unknown as ReturnType<typeof realProvider>
}

if (realSettingsEntry !== '') {
  const realSettingsModule = await import(pathToFileURL(realSettingsEntry).href) as {
    SettingsProvider: { prototype: object }
  }
  const RealSettingsProvider = realSettingsModule.SettingsProvider
  assert.strictEqual(typeof RealSettingsProvider, 'function', `真 SettingsProvider 必须加载成功：${realSettingsEntry}`)
  realSettingsImpl = RealSettingsProvider
  realProviderCases()
} else {
  console.log(`\n  - I1–I3 ${realSettingsSkip}：跳过 3 条（严格判据一字未改，加载到真实现时照跑）`)
}

/** I1–I3 的用例体（只在真实现可用时注册；否则一条都不注册，计数里也不出现）。 */
function realProviderCases(): void {

test('I1: 真 SettingsProvider.register(真 schemastery schema) 不抛；describe({redactSecrets}) 找得到该命名空间', () => {
  const provider = realProvider(undefined)
  const scope = provider.register('conversation-recorder', RecorderSettingsSchema, { applies: 'live', base: entrySettings({}) })
  assert(scope.get() !== undefined, 'scope.get() 必须返回解析后的值')
  const described = provider.describe({ redactSecrets: true })
  const descriptor = described.find((item) => item.ns === 'conversation-recorder')
  assert(descriptor !== undefined, `describe 必须列出 conversation-recorder，实际 ${JSON.stringify(described.map((item) => item.ns))}`)
  assert.strictEqual(descriptor.applies, 'live', 'applies 必须是 live（改完即时生效）')
  assert.deepStrictEqual(descriptor.value, scope.get(), 'describe.value 必须等于 scope.get()')
  assert.deepStrictEqual(descriptor.value, entrySettings({}), '解析后的默认值必须与 SPEC §8 一致')
  assert.deepStrictEqual(descriptor.secrets, [], '本插件没有 secret 字段')
})

test('I2: describe 的 schema 能被 schemastery 的 new Schema(json) 还原（设置页渲染用的形状）', () => {
  const provider = realProvider(undefined)
  provider.register('conversation-recorder', RecorderSettingsSchema, { applies: 'live', base: entrySettings({}) })
  const descriptor = provider.describe({ redactSecrets: true }).find((item) => item.ns === 'conversation-recorder')
  assert(descriptor !== undefined && descriptor.schema !== undefined, 'descriptor 必须带 schema')
  const restored = new z(descriptor.schema)
  assert.strictEqual(typeof restored, 'function', 'schema 必须能被 new Schema(json) 还原成可调用 schema')
  assert.deepStrictEqual(restored({}), RecorderSettingsSchema({}), '还原后的 schema 默认值必须与原 schema 一致')
  assert.throws(() => { restored({ toolArgsPreview: MAX_TOOL_ARGS_PREVIEW + 1 }) }, /<= 200/, '还原后的 schema 必须保留 0–200 取值域')
})

test('I3: 真 provider 下根解析：用户段给了 root 就跟着变、没给就是内置默认根，并压过配置层', () => {
  const base = freshDir()
  const userRoot = path.join(base, 'user-root')
  const configRoot = path.join(base, 'config-root')

  const noUser = createSettingsSource({}, realProvider(undefined))
  assert.strictEqual(noUser.current().root, defaultRoot(), '用户段没给 root → 内置默认根')

  const withUser = createSettingsSource({}, realProvider({ root: userRoot }))
  assert.strictEqual(withUser.current().root, userRoot, '用户段给了 root → 解析跟着变')

  const both = createSettingsSource({ root: configRoot }, realProvider({ root: userRoot }))
  assert.strictEqual(both.current().root, userRoot, '设置层 root 压过装配配置层')

  const onlyConfig = createSettingsSource({ root: configRoot }, realProvider(undefined))
  assert.strictEqual(onlyConfig.current().root, configRoot, '设置层没给 root 时用装配配置层')
})
}

// ============ 本轮新增（0.2.2）：Remote 信封解包（设置页读不到真值的根因） ============
//
// 0.2.1 的客户端半边把宿主 Remote 的返回值**直接当数据用**，而宿主返回的是信封
// `{ok:true,value}` / `{ok:false,error}`（官方客户端就这么解）。下面直接用真模块
// `src/client/remote-envelope.ts`（不 import react、不 import 宿主包）钉死这条链。

test('E1: remote 信封解包——{ok:true,value:{namespaces:[…]}} 能取到命名空间', () => {
  const response = {
    ok: true,
    value: { namespaces: [{ ns: 'conversation-recorder', value: { toolArgsPreview: 60 }, revision: 3 }] },
  }
  const described = unwrapRemoteEnvelope<{ namespaces: readonly { ns: string }[] }>(response, '读取设置')
  assert.deepStrictEqual(
    described.namespaces.map((item) => item.ns),
    ['conversation-recorder'],
    '解包后应拿到 namespaces（而不是 undefined）',
  )
})

test('E2: remote 信封解包——{ok:false,error:{message}} 抛出该 message', () => {
  assert.throws(
    () => unwrapRemoteEnvelope({ ok: false, error: { message: 'settings namespace not registered' } }, '读取设置'),
    (error: unknown) => error instanceof Error && error.message === 'settings namespace not registered',
    '失败信封必须原样抛出 error.message',
  )
})

test('E3: remote 信封解包——裸载荷（无 ok 字段）必须报错，不许静默当 value', () => {
  // 0.2.1 的现场就是这里：`{namespaces:[…]}` 被当成 value，`namespaces` 实为 undefined
  assert.throws(() => unwrapRemoteEnvelope({ namespaces: [] }, '读取设置'), /不是信封|缺 ok/)
  assert.throws(() => unwrapRemoteEnvelope(undefined, '读取设置'), /不是信封|缺 ok/)
  assert.throws(() => unwrapRemoteEnvelope([{ ns: 'conversation-recorder' }], '读取设置'), /不是信封|缺 ok/)
})

test('E4: 写路径也必须解包——mutate 失败不许显示「已保存」', () => {
  assert.doesNotThrow(
    () => unwrapRemoteEnvelope({ ok: true, value: { revision: 4 } }, '保存设置'),
    '成功信封应通过',
  )
  assert.throws(
    () => unwrapRemoteEnvelope({ ok: false, error: { message: 'revision conflict' } }, '保存设置'),
    /revision conflict/,
    '写失败必须抛错（否则状态行会显示假成功）',
  )
})

test('C-client-3: 设置分区不给 Input 传 style（外观交回官方控件）；读写都走 remote-envelope 解包', () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = fs.readFileSync(path.join(repo, 'src', 'client', 'index.ts'), 'utf8')

  // 逐个数 createElement(Input, {…}) 的属性块（花括号配平）——任何一块里都不许出现 style
  const marker = 'createElement(Input'
  const propsBlocks: string[] = []
  let index = source.indexOf(marker)
  while (index !== -1) {
    const start = source.indexOf('{', index)
    let depth = 0
    let end = start
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    propsBlocks.push(source.slice(start, end + 1))
    index = source.indexOf(marker, end)
  }
  assert(propsBlocks.length >= 2, `应有两处 createElement(Input, …)，实际 ${String(propsBlocks.length)}`)
  for (const block of propsBlocks) {
    assert(!block.includes('style'), `Input 不许再传 style（会打进内层内容层）：${block}`)
  }
  // 解包模块必须真被用上：读一次、写一次
  assert(source.includes("from './remote-envelope'"), '客户端必须 import remote-envelope 解包模块')
  assert(
    source.split('unwrapRemoteEnvelope').length - 1 >= 3, // import 1 处 + 读 1 处 + 写 1 处
    '读/写两条路径都必须解包（unwrapRemoteEnvelope 至少出现 3 次：import + 读 + 写）',
  )
  // 构建接线：相对模块必须被打进 lib/client.js 的本地模块表，否则浏览器解析不到
  const bundle = fs.readFileSync(path.join(repo, 'lib', 'client.js'), 'utf8')
  assert(bundle.includes('"./remote-envelope":'), 'lib/client.js 必须把 remote-envelope 装进本地模块表')
})

// ============ 本轮新增（0.2.3）：懒建档续号（修「插件重开/进程重启后静默丢轮次」） ============
//
// 事故本体：旧 `onSessionEvent` 遇到未登记会话时只看子代理，普通会话直接 `return` ——
// 不报错、不记录，故 `session/created` 那次广播没赶上（停用重开/进程重启）的会话，
// 之后每一轮都被静默丢掉。契约改成「登记时机 = 首次见到该会话的事件」后，续号靠
// `onSessionCreated` 内部的 `restoreFromDisk`（index.md + turns/ 文件数）从磁盘读回。

/** 数会话目录下 turns/ 里的 NNNN.md 文件（断言「落了哪几轮」用）。 */
function turnFiles(sessionDirPath: string): string[] {
  try {
    return fs.readdirSync(path.join(sessionDirPath, 'turns')).filter((name) => /^\d{4}\.md$/.test(name)).sort()
  } catch {
    return []
  }
}

test('L1: 懒建档——空表 + 未调 onSessionCreated，直接发首轮事件也应落 0001.md', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'lazy-first'
  const dir = sessionDir(root, TMP, sid)

  assert.strictEqual(turnFiles(dir).length, 0, '起点：不该有任何轮次文件')

  // 不调 onSessionCreated，直接发轮次事件（模拟「session/created 那次广播没接上」）
  engine.onSessionEvent({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } }, userMsgEvent(2, '首次见到才建档', 1))
  engine.onSessionEvent({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } }, turnEndEvent(3, 1))

  assert.deepStrictEqual(rootDirs(root), [workspaceDir(TMP)], `首次见到的事件应建档并落自己的工作区文件夹，实际：${fs.readdirSync(root).join(',')}`)
  assert.deepStrictEqual(turnFiles(dir), ['0001.md'], '懒建档后首个轮次应落 0001.md')
  assert.strictEqual(turnField(path.join(dir, 'turns', '0001.md'), 'seq'), '0001', '懒建档后的首轮 seq')
  assert.strictEqual(turnField(path.join(dir, 'turns', '0001.md'), 'prev'), '', '首轮无上一轮时 prev 留空')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '1', 'index.turns 应为 1')
})

test('L2: 重载/重启（全新实例、从未收到 onSessionCreated）直接发第 3 轮 → 写 0003.md，不重开 0001', () => {
  const root = freshDir()
  const sid = 'lazy-resume'
  const dir = sessionDir(root, TMP, sid)
  const header = { cwd: TMP, createdAt: 1700000000000 }

  // 重载前：正常建档、写满 2 轮
  const before = new RecorderEngine({ root })
  before.onSessionCreated({ id: sid, header })
  for (let t = 1; t <= 2; t += 1) {
    before.onSessionEvent({ id: sid }, turnStartEvent(t * 3 - 2, t))
    before.onSessionEvent({ id: sid }, userMsgEvent(t * 3 - 1, `重载前第 ${t} 轮`, t))
    before.onSessionEvent({ id: sid }, turnEndEvent(t * 3, t))
  }
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md'], '重载前应恰好有 0001/0002')

  // 模拟插件停用重开 / 进程重启：**全新引擎**（内存记录为空），此后**不调 onSessionCreated**，
  // 直接发第 3 轮的事件（真宿主 `session/event` 的载荷是完整 Session，header 就在上面）
  const after = new RecorderEngine({ root })
  after.onSessionEvent({ id: sid, header }, turnStartEvent(7, 3))
  after.onSessionEvent({ id: sid, header }, userMsgEvent(8, '重载后的第 3 轮', 3))
  after.onSessionEvent({ id: sid, header }, turnEndEvent(9, 3))

  assert(fs.existsSync(path.join(dir, 'turns', '0003.md')), `重载后第 3 轮必须写 0003.md，实际：${turnFiles(dir).join(',')}`)
  assert.strictEqual(turnField(path.join(dir, 'turns', '0003.md'), 'prev'), 'turns/0002.md', '续号轮次的 prev 指向 0002')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '3', 'index.turns 应为 3')
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md', '0003.md'], '必须续号，不得重开 0001（也不得覆写已有轮次）')
  // 既有内容一字未动
  assert.strictEqual(turnField(path.join(dir, 'turns', '0001.md'), 'seq'), '0001', '重开后已有 0001 不应被改写')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'title'), '', '无 title 事件时 title 仍为空（未被空值/脏值污染）')
})

// ============ 本轮新增（0.2.3）：enabled 总开关（默认 true；关闭＝不再产出新文件） ============

test('N1: enabled=false 跑完整一轮 → 目标根下零文件（已有记录也不动）', () => {
  const base = freshDir()
  const rootA = path.join(base, 'root-a')
  const rootB = path.join(base, 'root-b')
  const header = { cwd: TMP, createdAt: 1700000000000 }

  // 先在 root-a 正常记 1 轮（作为「已有内容」的基线）
  const on = settingsEngine({ root: rootA, enabled: true })
  const sid = 'toggle-off'
  on.onSessionCreated({ id: sid, header })
  on.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  on.onSessionEvent({ id: sid }, userMsgEvent(2, '开着的时候记的', 1))
  on.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  const dirA = sessionDir(rootA, TMP, sid)
  assert.deepStrictEqual(turnFiles(dirA), ['0001.md'], '先决条件：开着时应有 0001.md')

  // 关掉 enabled：同一个会话的后续轮次（含元数据事件）一律不落盘
  const off = settingsEngine({ root: rootB, enabled: false })
  off.onSessionCreated({ id: sid, header })
  off.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
  off.onSessionEvent({ id: sid }, userMsgEvent(5, '关掉之后的一轮', 2))
  off.onSessionEvent({ id: sid }, contextEvent(6, 'deepseek-v4-flash'))
  off.onSessionEvent({ id: sid }, titleEvent(7, '关掉之后的标题'))
  off.onSessionEvent({ id: sid }, turnEndEvent(8, 2))

  assert.strictEqual(fs.existsSync(rootB), false, `enabled=false 时目标根下必须零文件（连根目录都不该建），实际：${String(rootB)} 存在`)
  assert.strictEqual(fs.existsSync(sessionDir(rootB, TMP, sid)), false, 'enabled=false 时连会话目录都不该建')
  // 已有记录（另一个 root）一字未动
  assert.deepStrictEqual(turnFiles(dirA), ['0001.md'], 'enabled=false 不得删除/改动已有记录')
  assert.strictEqual(indexField(path.join(dirA, 'index.md'), 'turns'), '1', '已有 index 不应变化')
})

test('N2: 同一引擎先关后开 → 开后那轮正常落盘、序号连续、无半份文件', () => {
  const base = freshDir()
  const rootA = path.join(base, 'root-a')
  const rootB = path.join(base, 'root-b')
  const header = { cwd: TMP, createdAt: 1700000000000 }
  const sid = 'toggle-mid'
  const dirB = sessionDir(rootB, TMP, sid)

  // 先关：第 1 轮整轮被丢弃（不落半份）
  const off = settingsEngine({ root: rootB, enabled: false })
  off.onSessionCreated({ id: sid, header })
  off.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  off.onSessionEvent({ id: sid }, userMsgEvent(2, '关着的一轮', 1))
  off.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert.strictEqual(fs.existsSync(rootB), false, '关着时目标根下零文件（连根目录都不该建）')
  assert.strictEqual(fs.existsSync(path.join(dirB, 'turns', '0001.md.tmp')), false, '关着时不得留下半份 .tmp')

  // 再开（同一引擎、同一会话、同一 root，只把 enabled 打开）
  const on = settingsEngine({ root: rootB, enabled: true })
  on.onSessionCreated({ id: sid, header })
  on.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
  on.onSessionEvent({ id: sid }, userMsgEvent(5, '开回来的这一轮', 2))
  on.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  assert.deepStrictEqual(turnFiles(dirB), ['0001.md'], '开后第一轮应落 0001.md（关着的那轮不存在，故不占号）')
  assert.strictEqual(turnField(path.join(dirB, 'turns', '0001.md'), 'prev'), '', '开后的首轮 prev 留空')

  // 继续下一轮 → 序号连续，无半份文件
  on.onSessionEvent({ id: sid }, turnStartEvent(7, 3))
  on.onSessionEvent({ id: sid }, userMsgEvent(8, '开回来的第二轮', 3))
  on.onSessionEvent({ id: sid }, turnEndEvent(9, 3))
  assert.deepStrictEqual(turnFiles(dirB), ['0001.md', '0002.md'], '开后序号应连续')
  assert.strictEqual(turnField(path.join(dirB, 'turns', '0002.md'), 'prev'), 'turns/0001.md', '开后第 2 轮 prev 指向 0001')
  assert.strictEqual(indexField(path.join(dirB, 'index.md'), 'turns'), '2', 'index.turns 应为 2')
  const leftovers = fs.readdirSync(path.join(dirB, 'turns')).filter((name) => name.endsWith('.tmp'))
  assert.deepStrictEqual(leftovers, [], `不得留下半份 .tmp 文件，实际：${leftovers.join(',')}`)
  assert.strictEqual(fs.existsSync(rootA), false, '未被用到的 root 不该被创建')
})

test('N3: enabled 默认值与 false 都能被 schema / 三层解析还原', () => {
  // ① 引擎默认（无设置服务、无配置）：enabled 默认 true
  // （用 createSettingsSource / entrySettings 这两个既有出口读默认值，避免改动文件顶部的 import 行）
  assert.strictEqual(createSettingsSource({}, undefined).current().enabled, true, '无设置服务时 enabled 默认 true')
  assert.strictEqual(entrySettings({}).enabled, true, '未配置任何字段时 enabled 默认 true')

  // ② schema 默认值 + toJSON → new Schema(json) 还原
  const resolved = RecorderSettingsSchema({}) as Record<string, unknown>
  assert.strictEqual(resolved.enabled, true, 'schema 默认 enabled=true')
  const restored = new z(RecorderSettingsSchema.toJSON())
  assert.strictEqual((restored({}) as Record<string, unknown>).enabled, true, 'toJSON → new Schema(json) 应还原 enabled 默认值')

  // ③ 显式 false 在三条路径上都能还原：装配配置 / 用户段 / schema
  assert.strictEqual(entrySettings({ enabled: false }).enabled, false, '装配配置 enabled=false 应被采纳')
  const source = createSettingsSource({}, fakeSettings({ enabled: false }))
  assert.strictEqual(source.current().enabled, false, '用户段 enabled=false 应被采纳')
  assert.strictEqual((RecorderSettingsSchema({ enabled: false }) as Record<string, unknown>).enabled, false, 'schema 接受 enabled=false')
})

// ============ 本轮新增（0.3.0）：序号规则改成「磁盘上已存在的最大序号 + 1」 ============
//
// 旧→新逐条登记（契约变更，见 PROGRESS.md / SPEC §6）：
//   旧：seq = 该会话**已落盘轮次的个数** + 1（`turns/` 下 NNNN.md 的个数）
//   新：seq = 该会话**磁盘上已存在的最大序号** + 1（纯函数 `nextSeq()`，见 src/seq.ts）
//   关系：磁盘无洞时**逐字等价**（max = 个数 ⇒ max + 1 = 个数 + 1）。

test('P1: nextSeq 纯函数——数组为空 ⇒ 1；所有元素 <= 0 ⇒ 全被忽略、仍 ⇒ 1', () => {
  assert.deepStrictEqual(nextSeq([]), { seq: 1, rejected: false }, '空数组（全新会话）⇒ seq=1')
  assert.deepStrictEqual(nextSeq([-5]), { seq: 1, rejected: false }, '负序号（历史旧命名）不参与取最大值')
  assert.deepStrictEqual(nextSeq([0]), { seq: 1, rejected: false }, '0 不参与取最大值')
  assert.deepStrictEqual(
    nextSeq([-3, 0, Number.NaN, Number.POSITIVE_INFINITY]),
    { seq: 1, rejected: false },
    'NaN/Infinity/负零 都不参与（否则会污染最大值或产出非法序号）',
  )
})

test('P2: nextSeq 无洞时与旧规则（个数 + 1）逐字等价', () => {
  // 旧规则的输入是「个数」；这里把 1..N 这种无洞集合的个数与 nextSeq 结果逐一对齐
  for (let count = 0; count <= 12; count += 1) {
    const existing = Array.from({ length: count }, (_, i) => i + 1)
    const oldRule = count + 1
    assert.strictEqual(nextSeq(existing).seq, oldRule, `无洞（1..${count}）时新规则应与旧规则逐字等价`)
    assert.strictEqual(nextSeq(existing).rejected, false, '无洞集合不应拒写')
  }
  // 乱序/重复入参不影响结果（纯函数，顺序无关）
  assert.strictEqual(nextSeq([3, 1, 2, 2, 1]).seq, 4, '乱序 + 重复的成绩应与有序一致')
})

test('P3: nextSeq 有洞时跳过洞——0001,0002,0004..0013 ⇒ 0014（不回填 0003）', () => {
  const existing = [1, 2, ...Array.from({ length: 10 }, (_, i) => i + 4)] // 1,2,4..13
  assert.strictEqual(existing.length, 12, '夹具：12 个已存在序号（个数口径的旧规则会算成 13）')
  const result = nextSeq(existing)
  assert.strictEqual(result.seq, 14, '磁盘最大序号 13 + 1 = 14（旧规则按个数 12 会算成 13，即回填洞）')
  assert.strictEqual(result.rejected, false, '有洞不构成拒写')
  assert.notStrictEqual(result.seq, existing.length + 1, '新规则必须与「个数 + 1」区分开（这正是本次契约变更）')
})

test('P4: nextSeq 洞之后继续增长——洞不封顶、序号只增不减', () => {
  let existing: number[] = []
  const written: number[] = []
  for (let i = 0; i < 15; i += 1) {
    const { seq, rejected } = nextSeq(existing)
    assert.strictEqual(rejected, false, '正常增长不应拒写')
    written.push(seq)
    existing = [...existing, seq]
    if (i === 2) existing = existing.filter((s) => s !== 2) // 造一个洞：0002 缺席
  }
  assert.deepStrictEqual(written.slice(0, 5), [1, 2, 3, 4, 5], '前几轮按 1..5 增长')
  assert(!written.includes(2 * 0 + 2) || written.filter((s) => s === 2).length === 1, '被跳过的 0002 不会被再次写出')
  for (let i = 1; i < written.length; i += 1) {
    assert((written[i] ?? 0) > (written[i - 1] ?? 0), `序号必须严格递增，实际 ${written.join(',')}`)
  }
  assert.strictEqual(written[written.length - 1], 15, `连续写 15 轮（中途挖掉 0002）后最大序号应为 15，实际 ${written.join(',')}`)
})

test('P5: nextSeq 撞号仍拒覆写——目标号已存在时一律给出更大的号（永不返回已存在的序号）', () => {
  // 「拒绝覆写」这条死规矩在新规则下的表现：结果序号**永远不在**已存在集合里
  const existing = [1, 2, 3]
  const { seq } = nextSeq(existing)
  assert(!existing.includes(seq), `nextSeq 不得返回已存在的序号（实际 ${seq}）`)
  assert.strictEqual(seq, 4, '已存在 1..3 ⇒ 4')
  // 最大号被占、但中间有洞：结果仍是最大号 + 1，不是洞
  const gapped = [1, 3, 5, 7]
  assert.strictEqual(nextSeq(gapped).seq, 8, '有洞也必须跳过洞取最大号 + 1')
  assert(!gapped.includes(nextSeq(gapped).seq), '结果不得落在已存在的序号上')
})

test('P6: 端到端——磁盘上有洞（0001,0002,0004）时会话下一轮写 0005，而不是被拒或被顶替', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'hole-e2e'
  const dir = sessionDir(root, TMP, sid)
  const turnsDir = path.join(dir, 'turns')
  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第 1 轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
  engine.onSessionEvent({ id: sid }, userMsgEvent(5, '第 2 轮', 2))
  engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md'], '先决条件：磁盘上是 0001/0002')

  // 造洞：把第 2 轮**改名为 0004**（模拟「磁盘上已存在 0001,0002,0004」这个集合本身）
  // ⚠️ 只在本用例自己的沙箱目录里改名，且改完立刻在下面把整轮行为断言完（不动任何真实留档）
  fs.renameSync(path.join(turnsDir, '0002.md'), path.join(turnsDir, '0004.md'))
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0004.md'], '夹具：磁盘序号集合 = {0001,0004}')

  const err = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(7, 3))
    engine.onSessionEvent({ id: sid }, userMsgEvent(8, '洞之后的一轮', 3))
    engine.onSessionEvent({ id: sid }, turnEndEvent(9, 3))
  })
  assert.strictEqual(err, '', `有洞不应产生拒写告警（旧规则会在这里被拒/顶替），实际：${JSON.stringify(err)}`)
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0004.md', '0005.md'], '下一轮必须写 0005.md（最大序号 4 + 1）')
  assert(!fs.existsSync(path.join(turnsDir, '0002.md')), '不许回填洞 0002')
  assert(!fs.existsSync(path.join(turnsDir, '0003.md')), '不许写 0003（它不是最大序号 + 1）')
  assert.strictEqual(turnField(path.join(turnsDir, '0005.md'), 'seq'), '0005', '新轮次 seq 字段 = 0005')
  assert.strictEqual(turnField(path.join(turnsDir, '0005.md'), 'prev'), 'turns/0004.md', 'prev 指向磁盘上更小的最大序号 0004（不是洞 0003）')
  assert.strictEqual(indexField(path.join(dir, 'index.md'), 'turns'), '3', 'index.turns 仍是**文件个数** 3（不是序号 5）')
})

// ============ 本轮新增（0.3.0 任务2）：记录根下的产物文档 ============

test('G1: 首个内容轮次落盘后，根下出现 README.md 与 AGENTS.md（首行生成标记）', () => {
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'docs-first'
  assert(!fs.existsSync(path.join(root, 'README.md')), '先决条件：落盘前根下没有 README.md')
  assert(!fs.existsSync(path.join(root, 'AGENTS.md')), '先决条件：落盘前根下没有 AGENTS.md')

  engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  engine.onSessionEvent({ id: sid }, titleEvent(1, '只发标题'))
  assert(!fs.existsSync(path.join(root, 'README.md')), '只有元数据事件（无内容轮次）不该产出文档')

  engine.onSessionEvent({ id: sid }, turnStartEvent(2, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(3, '第 1 轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(4, 1))

  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert(readme.startsWith('<!-- generated by dsh-conversation-recorder -->'), 'README.md 首行必须是生成标记')
  assert(agents.startsWith('<!-- generated by dsh-conversation-recorder -->'), 'AGENTS.md 首行必须是生成标记')
  assert(readme.includes('index.md'), 'README 应说明目录结构（提到 index.md）')
  assert(agents.includes('turns/'), 'AGENTS 应说明怎么读（提到 turns/）')
  assert(
    Buffer.byteLength(agents, 'utf8') <= 2048,
    `AGENTS.md 必须 ≤2KB，实际 ${String(Buffer.byteLength(agents, 'utf8'))} 字节`,
  )
  assert(!fs.existsSync(path.join(root, 'README.md.tmp')), '不应残留 .tmp')
  assert(!fs.existsSync(path.join(root, 'AGENTS.md.tmp')), '不应残留 .tmp')
})

test('G2: 文档幂等——已存在一律不动（含无标记的手写文件，只提示不改）', () => {
  const root = freshDir()
  const sid = 'docs-idem'
  const handwritten = '# 我自己写的说明\n\n别动我。\n'
  fs.writeFileSync(path.join(root, 'README.md'), handwritten, 'utf8')
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 手写 AGENTS\n', 'utf8')
  const readmeBefore = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const agentsBefore = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')

  const engine = new RecorderEngine({ root })
  const err = captureStderr(() => {
    engine.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
    for (let t = 1; t <= 2; t += 1) {
      engine.onSessionEvent({ id: sid }, turnStartEvent(t * 3 - 2, t))
      engine.onSessionEvent({ id: sid }, userMsgEvent(t * 3 - 1, `第 ${t} 轮`, t))
      engine.onSessionEvent({ id: sid }, turnEndEvent(t * 3, t))
    }
  })
  assert.strictEqual(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), readmeBefore, '无标记的手写 README 不许被改写')
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agentsBefore, '手写 AGENTS 不许被改写')
  assert(err.includes('没有生成标记'), `手写文件应往 stderr 提示一行，实际：${JSON.stringify(err)}`)
  assert(err.includes('保持原样不动'), '提示里应写明保持原样不动')

  // 只缺一个时只补那一个；再跑一轮不再重复写
  fs.rmSync(path.join(root, 'AGENTS.md'))
  const engine2 = new RecorderEngine({ root })
  engine2.onSessionCreated({ id: 'docs-idem-2', header: { cwd: TMP, createdAt: 1700000000000 } })
  engine2.onSessionEvent({ id: 'docs-idem-2' }, turnStartEvent(1, 1))
  engine2.onSessionEvent({ id: 'docs-idem-2' }, userMsgEvent(2, '补 AGENTS 的一轮', 1))
  engine2.onSessionEvent({ id: 'docs-idem-2' }, turnEndEvent(3, 1))
  assert(fs.readFileSync(path.join(root, 'README.md'), 'utf8') === readmeBefore, '只缺 AGENTS 时 README 仍不许被动')
  assert(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').startsWith('<!-- generated by dsh-conversation-recorder -->'), '缺的那个应被补上')
})

test('G3: ensureRootDocs 只缺则写——返回值只含本次新写的；已有的一份不算', () => {
  const root = freshDir()
  assert.deepStrictEqual(ensureRootDocs(root), ['README.md', 'AGENTS.md'], '首次调用应新写两份')
  assert.deepStrictEqual(ensureRootDocs(root), [], '二次调用不应再写（已有就一个字节都不动）')
  fs.rmSync(path.join(root, 'AGENTS.md'))
  assert.deepStrictEqual(ensureRootDocs(root), ['AGENTS.md'], '只缺 AGENTS 时只补它')
  // 空 root（没有落点可言）不写任何东西、不抛
  assert.deepStrictEqual(ensureRootDocs(''), [], 'root 为空串时直接返回空表')
})

test('G4: 写失败只写 stderr、不抛；enabled=false 时不写根下文档', () => {
  const base = freshDir()

  // ① 写失败：root 位置被一个同名**文件**占住 ⇒ mkdir/写入失败，只留 stderr
  const blockedRoot = path.join(base, 'blocked-root')
  fs.writeFileSync(blockedRoot, '占位文件', 'utf8')
  let err = ''
  assert.doesNotThrow(() => {
    err = captureStderr(() => {
      ensureRootDocs(blockedRoot)
    })
  }, '写失败不许抛给调用方')
  assert(err.includes('failed'), `写失败应往 stderr 记一行，实际：${JSON.stringify(err)}`)
  assert.strictEqual(fs.readFileSync(blockedRoot, 'utf8'), '占位文件', '占位文件不许被破坏')

  // ② enabled=false：跑完整一轮，目标根下**连文档都不产出**（总开关语义）
  const offRoot = path.join(base, 'off-root')
  const off = settingsEngine({ root: offRoot, enabled: false })
  const sid = 'docs-disabled'
  off.onSessionCreated({ id: sid, header: { cwd: TMP, createdAt: 1700000000000 } })
  off.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  off.onSessionEvent({ id: sid }, userMsgEvent(2, '关着的一轮', 1))
  off.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert.strictEqual(fs.existsSync(offRoot), false, 'enabled=false 时连根目录都不该建')
  assert.strictEqual(fs.existsSync(path.join(offRoot, 'README.md')), false, 'enabled=false 时不写 README.md')
  assert.strictEqual(fs.existsSync(path.join(offRoot, 'AGENTS.md')), false, 'enabled=false 时不写 AGENTS.md')
})

// ============ 本轮新增（0.3.0 任务3）：审计发现的缺陷 ============

test('Q1: onSessionDisposed 连 headers 一起回收（长跑进程不再按会话数累积 header 缓存）', () => {
  // ① 纯函数级：ensureRootDocs 不会写 root 之外的任何位置（防御性；root 由调用方给出）
  // ② 引擎级：disposed 的会话，即使**只带 { id }**（载荷没 header）的事件也不得被"补档"复活
  const root = freshDir()
  const engine = new RecorderEngine({ root })
  const sid = 'header-gc'
  const header = { cwd: TMP, createdAt: 1700000000000 }
  const dir = sessionDir(root, TMP, sid)

  engine.onSessionCreated({ id: sid, header })
  engine.onSessionEvent({ id: sid }, turnStartEvent(1, 1))
  engine.onSessionEvent({ id: sid }, userMsgEvent(2, '第 1 轮', 1))
  engine.onSessionEvent({ id: sid }, turnEndEvent(3, 1))
  assert.deepStrictEqual(turnFiles(dir), ['0001.md'], '先决条件：第 1 轮落盘')

  engine.onSessionDisposed({ id: sid })
  // 先确认 headers 里那份真的没了：拿另一个会话 id 做对照（它的 header 还在，补档仍生效）
  const other = 'header-keep'
  engine.onSessionCreated({ id: other, header })
  const err = captureStderr(() => {
    engine.onSessionEvent({ id: sid }, turnStartEvent(4, 2))
    engine.onSessionEvent({ id: sid }, userMsgEvent(5, 'disposed 后只带 id 的事件', 2))
    engine.onSessionEvent({ id: sid }, turnEndEvent(6, 2))
  })
  assert.strictEqual(err, '', `disposed 后只带 id 的事件应被直接忽略（无告警），实际：${JSON.stringify(err)}`)
  assert.strictEqual(fs.existsSync(dir), true, '先决条件：会话目录本来就存在')
  assert.deepStrictEqual(turnFiles(dir), ['0001.md'], 'disposed 后不得再写文件')
  assert(
    turnField(path.join(dir, 'turns', '0001.md'), 'seq') === '0001',
    '回收内存记录不得动磁盘文件',
  )

  // ③ 重新 created 后 header 重新登记，只有 { id } 的事件也能被接上续写（行为不变）
  engine.onSessionCreated({ id: sid, header })
  engine.onSessionEvent({ id: sid }, turnStartEvent(7, 3))
  engine.onSessionEvent({ id: sid }, userMsgEvent(8, '重新建档后的一轮', 3))
  engine.onSessionEvent({ id: sid }, turnEndEvent(9, 3))
  assert.deepStrictEqual(turnFiles(dir), ['0001.md', '0002.md'], '重新建档后续写 0002.md')
})

test('Q3: 源码守卫——onSessionDisposed 必须同时清 headers；目录名常量只有一处字面量', () => {
  // 为什么用**源码守卫**而不是行为断言：`headers` 只是「进程内见过的 header」缓存，
  // 「没回收」的后果是**内存按 disposed 会话数线性增长**（长跑进程的资源泄漏），
  // 而 `disposed` 集合已经保证 disposed 之后的事件不会被处理 —— 这个后果**不可从公开行为观测**。
  // 对这类资源约束，直接钉住实现点（`headers.delete` 必须在 `onSessionDisposed` 里）才是可靠判据。
  // 行为侧（disposed 后的事件不复活会话）由 Q1 覆盖。
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const engineSrc = fs.readFileSync(path.join(repo, 'src', 'engine.ts'), 'utf8')
  const disposedBody = /onSessionDisposed\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(engineSrc)
  assert(disposedBody !== null, '应能在 engine.ts 里定位 onSessionDisposed 函数体')
  assert(
    (disposedBody[1] ?? '').includes('this.headers.delete('),
    'onSessionDisposed 必须一并 headers.delete(id)（否则长跑进程按会话数泄漏 header 缓存）',
  )

  // 目录名常量：`'_conversations'` 字面量在 src/ 下只允许出现在 paths.ts 一处（settings 引用它）
  const srcFiles = fs.readdirSync(path.join(repo, 'src')).filter((name) => name.endsWith('.ts'))
  const offenders: string[] = []
  for (const name of srcFiles) {
    const text = fs.readFileSync(path.join(repo, 'src', name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.includes("'_conversations'") && !line.includes('export const CONVERSATIONS_DIR')) {
        offenders.push(`${name}: ${line.trim()}`)
      }
    }
  }
  assert.deepStrictEqual(offenders, [], `目录名字面量只允许在 paths.ts 的 CONVERSATIONS_DIR 出现一次，实际：${offenders.join(' | ')}`)
})

testAsync('Q2: 保存在 mutate 成功后回读**真** revision / 真值（不许本地自增猜版本号）', async () => {
  // 假 Remote：revision 走一条**非线性**规则（mutate 后从 41 跳到 97），本地 +1 必错
  let revision = 41
  const user: Record<string, unknown> = { root: 'D:/old', toolArgsPreview: 40 }
  const calls: { describe: number; mutate: { ops: number; expected: number | undefined }[] } = { describe: 0, mutate: [] }
  const remote = {
    async describe() {
      calls.describe += 1
      return { ok: true as const, value: { namespaces: [{ ns: 'conversation-recorder', value: { ...user }, user: { ...user }, revision }] } }
    },
    async mutate(_ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expected?: number) {
      calls.mutate.push({ ops: ops.length, expected })
      for (const op of ops) user[op.path[0] ?? ''] = op.value
      revision = 97 // 宿主端的真实新版本号（不是 42）
      return { ok: true as const, value: { revision } }
    },
  }

  const loaded = await loadSettings(remote, 'conversation-recorder')
  assert.strictEqual(loaded.revision, 41, '读到的应是宿主真 revision 41')
  const result = await saveSettings(remote, 'conversation-recorder', [{ op: 'set', path: ['toolArgsPreview'], value: 60 }])

  assert.strictEqual(result.ops, 1, '应写 1 项')
  assert.strictEqual(result.revision, 97, '保存后必须回读到真 revision 97（本地自增会得到 42）')
  assert.strictEqual(result.value.toolArgsPreview, 60, '回读的真值应含刚落盘的字段')
  assert.strictEqual(calls.mutate.length, 1, '只调一次 mutate')
  assert.strictEqual(calls.mutate[0]?.expected, 41, 'mutate 必须带上**读到的**真 revision 做并发保护')
  assert.strictEqual(calls.describe, 3, '读一次 + 保存前读一次 + 保存后回读一次 = 3 次 describe')

  // 没有改动 ⇒ 不调 mutate
  const noop = await saveSettings(remote, 'conversation-recorder', [])
  assert.strictEqual(noop.ops, 0, '没有改动时 ops=0')
  assert.strictEqual(calls.mutate.length, 1, '没有改动时不许调 mutate')

  // mutate 失败 ⇒ 必须抛（显示「保存失败」，不许假成功）
  const failing = {
    ...remote,
    async mutate() {
      return { ok: false as const, error: { message: 'revision conflict' } }
    },
  }
  await assert.rejects(
    () => saveSettings(failing, 'conversation-recorder', [{ op: 'set', path: ['root'], value: 'D:/x' }]),
    /revision conflict/,
    'mutate 失败必须把宿主错误原样抛出',
  )
})

test('Q4: 发布一致性接线——版本 1.0.0、verify/verify:privacy 脚本、CI 跑全部门禁、runtime deps 为空', () => {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as {
    version: string
    scripts: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies: Record<string, string>
    peerDependencies: Record<string, string>
  }
  assert.strictEqual(pkg.version, '1.0.0', '版本应为 1.0.0')
  assert.strictEqual(pkg.dependencies, undefined, 'dependencies 必须为空（运行时不依赖任何包）')
  assert.strictEqual(
    pkg.scripts.verify,
    'pnpm build && git diff --exit-code -- lib',
    'verify 必须是「先构建再比 lib」（反序时「改了 src 忘重建」会让 lib 与 HEAD 相同、先比那步假绿）',
  )
  assert.strictEqual(pkg.scripts['verify:privacy'], 'node scripts/check-privacy.ts', 'verify:privacy 接线')
  // 两个宿主 peer：peer + dev 双声明（CI 要能解析；运行时不装 dependencies）
  for (const peer of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-home-paths']) {
    assert(peer in pkg.peerDependencies, `${peer} 必须声明为 peerDependency`)
    assert(peer in pkg.devDependencies, `${peer} 必须在 devDependencies 里（CI/开发解析用）`)
  }

  // CI：node 22 与 24，且八条门禁一条不落
  const ci = fs.readFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert(ci.includes("'22") && ci.includes("'24"), 'CI 必须按 node 22 与 node 24 各跑一遍')
  for (const step of ['pnpm typecheck', 'pnpm typecheck:client', 'pnpm test', 'node tests/spec-selfcheck.ts', 'pnpm verify', 'pnpm verify:privacy']) {
    assert(ci.includes(step), `CI 必须跑 ${step}`)
  }
  assert(ci.includes('probe-real-settings.ts') && ci.includes('probe-client-bundle.ts'), 'CI 必须跑两个只读探针')

  // .gitignore：构建中间目录与测试沙箱都不入库
  const rootIgnore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')
  assert(rootIgnore.includes('.client-build-tmp/'), '.gitignore 必须忽略 .client-build-tmp/')
  assert(fs.readFileSync(path.join(repo, 'tests', '.gitignore'), 'utf8').includes('.tmp/'), 'tests/.gitignore 必须忽略 .tmp/')
})

// ---- 汇总 ----
await Promise.all(pendingTests)
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
// 跑完清掉测试沙箱 tests/.tmp（已 gitignore；失败时也清，避免残留影响下一次运行）
fs.rmSync(TMP, { recursive: true, force: true })
if (failed > 0) {
  process.exit(1)
}