/**
 * 宿主 Remote 返回**信封**的解包模块。
 *
 * 宿主 settings Remote 的每个方法返回的都是信封，而不是数据本身：
 *   - 成功：`{ ok: true, value }`
 *   - 失败：`{ ok: false, error: { message } }`
 * 官方设置页就是这么解的（`dsh-client-ui-settings/lib/client.js`：
 * `response.ok ? { view: response.value } : { failure: response.error.message }`）。
 *
 * 0.2.1 的客户端半边把返回值**直接当数据用** ⇒ 浏览器里
 * `Cannot read properties of undefined (reading 'find')`，四个值只能显示本地假默认、
 * 保存也显示假成功。本模块就是那条修复：所有 Remote 返回值必须先过这里。
 *
 * 约束（任务书要求）：本文件**不 import react、也不 import 任何宿主包** ——
 * 只有零依赖的纯函数，好让 `tests/run.ts` 直接 import 它做用例。
 */

/** 宿主 Remote 的成功信封。 */
export interface RemoteEnvelopeSuccess<T> {
  readonly ok: true
  readonly value: T
}

/** 宿主 Remote 的失败信封（`error.message` 是官方客户端读的字段）。 */
export interface RemoteEnvelopeFailure {
  readonly ok: false
  readonly error: { readonly message?: unknown }
}

/** 宿主 Remote 返回的两种信封。 */
export type RemoteEnvelope<T> = RemoteEnvelopeSuccess<T> | RemoteEnvelopeFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 给报错信息用的形状摘要（避免把整个载荷打进日志）。 */
function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 解包一个宿主 Remote 信封。
 *
 * - `{ ok: true, value }` → 返回 `value`；
 * - `{ ok: false, error: { message } }` → 抛出 `error.message`；
 * - **裸载荷（没有 `ok` 字段）→ 直接抛错**。这一条是关键：0.2.1 就是这么错的，
 *   不许静默把返回值当 `value`（否则坏值会一路装成"读到了"）。
 *
 * @param response 宿主 Remote 的原始返回值
 * @param action   出错的场景名（`读取设置` / `保存设置`），拼进报错信息
 */
export function unwrapRemoteEnvelope<T>(response: unknown, action: string): T {
  if (!isRecord(response) || typeof response.ok !== 'boolean') {
    throw new Error(
      `${action}失败：宿主 Remote 没有返回信封（缺 ok 字段，实际 ${shapeOf(response)}）——不许把裸载荷当 value`,
    )
  }
  if (response.ok) {
    return response.value as T
  }
  const error = response.error
  const message = isRecord(error) && typeof error.message === 'string' && error.message !== ''
    ? error.message
    : '宿主未提供错误信息'
  throw new Error(message)
}

/* ------------------------------------------------------------------ *
 * 设置读写流程（与官方设置页同一条 Remote 通道，SPEC §8「设置页分区」）
 *
 * 放在本模块（而不是另开一个文件）有两个原因：
 *   1. 本模块**不 import react、不 import 任何宿主包**，所以 `tests/run.ts` 能直接 import 它
 *      跑真流程用例（下面的流程因此被用例钉住，不是「写了没测」）；
 *   2. 客户端源码里的相对 import **不能带 `.ts` 扩展名**（`build-client.mjs` 直出 CJS 的
 *      产物要能在浏览器解析），而 Node 直接跑 `.ts` 时**必须**带扩展名 —— 两个要求互斥，
 *      所以流程只能挂在「已有 import 链」的这个模块上，不能再多一层相对 import。
 * ------------------------------------------------------------------ */

/** 官方 settings Remote 描述的本命名空间（只声明本插件用到的字段）。 */
export interface SettingsDescriptor {
  readonly ns: string
  readonly value: Record<string, unknown>
  readonly user?: Record<string, unknown>
  /** 宿主给的**真** revision（并发保护用；不许本地自增猜测）。 */
  readonly revision: number
}

/** 读写设置需要的最小 Remote 面（与宿主 `remote.settings` 同形）。 */
export interface SettingsRemoteLike {
  describe(): Promise<RemoteEnvelope<{ namespaces: readonly SettingsDescriptor[] }>>
  mutate(
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision?: number,
  ): Promise<RemoteEnvelope<unknown>>
}

/** 一次「读设置」的结果：真值 + 真 revision（命名空间缺注册时 descriptor 为 undefined）。 */
export interface LoadedSettings {
  readonly descriptor: SettingsDescriptor | undefined
  readonly value: Record<string, unknown>
  readonly revision?: number
}

/**
 * 读一次设置：解信封 → 在 `namespaces` 里找本命名空间。
 * 读失败（信封 `ok:false` 或裸载荷）由 `unwrapRemoteEnvelope` 抛错，调用方显示在状态行。
 */
export async function loadSettings(remote: SettingsRemoteLike, ns: string): Promise<LoadedSettings> {
  const described = unwrapRemoteEnvelope<{ namespaces: readonly SettingsDescriptor[] }>(
    await remote.describe(),
    '读取设置',
  )
  const descriptor = described.namespaces.find((candidate) => candidate.ns === ns)
  return {
    descriptor,
    value: descriptor === undefined ? {} : descriptor.value,
    ...(descriptor === undefined ? {} : { revision: descriptor.revision }),
  }
}

/** `saveSettings` 的结果：写了几项 + **回读到的**真值/真 revision。 */
export interface SaveResult {
  readonly ops: number
  readonly value: Record<string, unknown>
  /** 回读的真 revision；宿主没给（describe 里找不到命名空间）时为 undefined。 */
  readonly revision?: number
}

/**
 * 保存设置：**读真值 → 只发改动过的字段（带真 revision）→ 成功后回读真 revision**。
 *
 * 0.2.x 的写法是本地 `setRevision(previous => (previous ?? 0) + 1)`，即**自己猜**新版本号：
 * 只要宿主端的 revision 不是「+1」这种朴素规则（并发写、别处改过设置、宿主内部每次 mutate
 * 递增的基数不同），猜出来的号就是错的，下一次保存必然 revision conflict。
 *
 * - `ops` 为空 ⇒ 不调 mutate，直接返回 `{ ops: 0, …当前真值 }`（调用方显示「没有变化」）。
 * - mutate 失败（`ok:false`）由 `unwrapRemoteEnvelope` 抛错 ⇒ 调用方显示红色「保存失败：…」，
 *   不再出现「假成功」。
 * - **回读**：mutate 成功后再 describe 一次，把宿主的真 revision 与真值带回去；
 *   绝不本地自增、绝不猜版本号。
 */
export async function saveSettings(
  remote: SettingsRemoteLike,
  ns: string,
  ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
): Promise<SaveResult> {
  if (ops.length === 0) {
    const current = await loadSettings(remote, ns)
    return { ops: 0, value: current.value, ...(current.revision === undefined ? {} : { revision: current.revision }) }
  }
  const before = await loadSettings(remote, ns)
  unwrapRemoteEnvelope<unknown>(
    await remote.mutate(ns, ops, before.revision),
    '保存设置',
  )
  // 关键：回读**真** revision（不本地 +1 猜）
  const after = await loadSettings(remote, ns)
  return { ops: ops.length, value: after.value, ...(after.revision === undefined ? {} : { revision: after.revision }) }
}
