/**
 * dsh-conversation-recorder —— 契约文本的渲染与回填读取。
 *
 * 只有本模块知道 md 长什么样：index/轮次 frontmatter、三列轮次表、轮次正文，
 * 以及 resume 自愈需要的「从磁盘读回元数据」。渲染是纯函数，读取只读不写。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** 无用户文本时的占位行。 */
export const NO_USER_TEXT = '（无用户文本）'
/** 无 agent 回答时的占位行。 */
export const NO_ASSISTANT_TEXT = '（无正文）'

/** 轮次表一行（从 turns/NNNN.md 读回的 time/kind）。 */
export interface TurnRow {
  readonly seq: number
  readonly time: string
  readonly kind: string
}

/** index.md 的会话元数据。 */
export interface SessionMeta {
  readonly id: string
  readonly title: string
  readonly startedIso: string
  readonly model: string
  readonly turns: number
  readonly forkFrom: string
}

/** 轮次文件的全部内容来源。 */
export interface TurnContent {
  readonly session: string
  readonly seq: number
  readonly time: string
  readonly kind: string
  readonly prev: string
  readonly userLines: readonly string[]
  readonly assistantLines: readonly string[]
  readonly refNote: string | null
  readonly toolLines: readonly string[]
}

/** index.md frontmatter 读回值（读不到/坏文件 → null 字段为空串、turns 为 0）。 */
export interface IndexMeta {
  readonly title: string
  readonly model: string
  readonly forkFrom: string
  readonly turns: number
}

function frontmatterLine(key: string, value: string): string {
  return `${key}: ${value}`
}

/** 轮次 frontmatter（字段：session/seq/time/kind/prev；契约已无 links/files）。 */
export function turnFrontmatter(turn: TurnContent): string[] {
  return [
    '---',
    frontmatterLine('session', turn.session),
    frontmatterLine('seq', String(turn.seq).padStart(4, '0')),
    frontmatterLine('time', turn.time),
    frontmatterLine('kind', turn.kind),
    frontmatterLine('prev', turn.prev),
    '---',
  ]
}

/** 轮次正文：## user（含引用行、工具清单行）+ ## assistant。 */
export function turnBody(turn: TurnContent): string[] {
  const lines: string[] = [...turnFrontmatter(turn), '', '## user']
  if (turn.userLines.length === 0) {
    lines.push(NO_USER_TEXT)
  } else {
    lines.push(...turn.userLines)
  }
  if (turn.refNote !== null) {
    lines.push('', `- 引用会话 ${turn.refNote}`)
  }
  if (turn.toolLines.length > 0) {
    lines.push('', ...turn.toolLines)
  }
  lines.push('', '## assistant')
  if (turn.assistantLines.length === 0) {
    lines.push(NO_ASSISTANT_TEXT)
  } else {
    lines.push(...turn.assistantLines)
  }
  return lines
}

/** 完整轮次文件文本（末尾单个换行）。 */
export function renderTurn(turn: TurnContent): string {
  return turnBody(turn).join('\n') + '\n'
}

/** index frontmatter（字段：title/session/started/model/turns/fork_from）。 */
export function indexFrontmatter(meta: SessionMeta): string[] {
  return [
    '---',
    frontmatterLine('title', meta.title),
    frontmatterLine('session', meta.id),
    frontmatterLine('started', meta.startedIso),
    frontmatterLine('model', meta.model),
    frontmatterLine('turns', String(meta.turns)),
    frontmatterLine('fork_from', meta.forkFrom),
    '---',
  ]
}

/** 三列轮次表（`| seq | time | kind |`；契约已无摘要列）。 */
export function turnTable(rows: readonly TurnRow[]): string[] {
  const lines: string[] = ['| seq | time | kind |', '| --- | ---- | ---- |']
  for (const row of rows) {
    lines.push(`| ${String(row.seq).padStart(4, '0')} | ${row.time} | ${row.kind} |`)
  }
  return lines
}

/** 完整 index.md 文本（frontmatter + 轮次表）。 */
export function renderIndex(meta: SessionMeta, rows: readonly TurnRow[]): string {
  return [...indexFrontmatter(meta), '', ...turnTable(rows)].join('\n') + '\n'
}

/** 取 frontmatter 某字段值；缺字段返回空串。 */
function readField(text: string, key: string): string {
  const m = new RegExp(`^${key}:[ \\t]?(.*)$`, 'm').exec(text)
  return m === null ? '' : (m[1] ?? '').trim()
}

/** 从 index.md 读回元数据（resume 自愈用）；文件不存在或读失败返回 null。 */
export function readIndexMeta(indexFile: string): IndexMeta | null {
  let text: string
  try {
    text = fs.readFileSync(indexFile, 'utf8')
  } catch {
    return null
  }
  const turnsText = readField(text, 'turns')
  const turns = /^\d+$/.test(turnsText) ? Number(turnsText) : 0
  return {
    title: readField(text, 'title'),
    model: readField(text, 'model'),
    forkFrom: readField(text, 'fork_from'),
    turns,
  }
}

/** 数 turns/ 下 `NNNN.md` 个数（目录不存在 → 0；读失败 → undefined）。 */
export function countTurnFiles(turnsDir: string): number | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(turnsDir)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return 0
    return undefined
  }
  return names.filter((name) => /^\d{4}\.md$/.test(name)).length
}

/**
 * 扫 turns/ 读回**磁盘上已存在的序号集合**（SPEC §6 的「磁盘最大序号」来源）。
 *
 * 与 `countTurnFiles` 的区别：这里要的是序号的**具体值**（含洞，例如 `0001,0002,0004`），
 * 不是个数——个数口径正是被跳过的轮次卡死后续记录的原因（见 `src/seq.ts`）。
 *
 * @param turnsDir - `<会话目录>/turns`
 * @returns 序号数组（未排序，可能含重复）；目录不存在 → `[]`；读失败 → `undefined`
 *          （调用方据此区分「空会话」与「读不出来」，后者不许当成空会话重开序号）
 */
export function scanTurnSeqs(turnsDir: string): number[] | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(turnsDir)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return []
    return undefined
  }
  const seqs: number[] = []
  for (const name of names) {
    const m = /^(\d{4})\.md$/.exec(name)
    if (m === null) continue // 只认 4 位零填充的轮次文件（.tmp、旧命名 00-1.md 等一律不参与）
    seqs.push(Number(m[1]))
  }
  return seqs
}

/** 扫 turns/ 读回每轮的 seq/time/kind（按 seq 升序；目录缺失返回空表）。 */
export function readTurnRows(dir: string): TurnRow[] {
  const turnsDir = path.join(dir, 'turns')
  let names: string[]
  try {
    names = fs.readdirSync(turnsDir)
  } catch {
    return []
  }
  const rows: TurnRow[] = []
  for (const name of names) {
    const m = /^(\d{4})\.md$/.exec(name)
    if (m === null) continue
    let time = ''
    let kind = ''
    try {
      const text = fs.readFileSync(path.join(turnsDir, name), 'utf8')
      time = readField(text, 'time')
      kind = readField(text, 'kind')
    } catch {
      // 忽略损坏轮次文件
    }
    rows.push({ seq: Number(m[1]), time, kind })
  }
  rows.sort((a, b) => a.seq - b.seq)
  return rows
}
