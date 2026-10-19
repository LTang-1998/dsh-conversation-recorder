/**
 * 客户端 bundle 的加载链检查（可复用）：
 * 给 `lib/client.js` 搭一个最小浏览器内核替身 —— `window.__ModuleLoader__.load({id, factory})`
 * 的自注册 → 工厂物化 → `apply()` 注册 `settings.section` 槽 → 槽的 `inject` 面带一份
 * `configForms` 表单。
 *
 * 供 `tests/run.ts` 的用例与 `tests/probe-client-bundle.ts` 探针共用（真代码，不 mock 被测对象）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface ClientBundleProbe {
  readonly bundlePath: string
  readonly bytes: number
  readonly registrations: readonly string[]
  readonly exportKeys: readonly string[]
  readonly inject: readonly string[]
  /** 槽定义（`settings.section`）。 */
  readonly section: { readonly name: string; readonly id: string; readonly label: string; readonly locale: string }
  /** 槽 `inject()` 返回面的键。 */
  readonly injectFaceKeys: readonly string[]
  /** `apply` 向 configForms 请求的条目 id（应为插件 profile 条目 id）。 */
  readonly formEntryId: string
  readonly source: string
}

/** 跑一遍加载链；任何一步不符合契约就抛错。 */
export function probeClientBundle(bundlePath = path.join(repo, 'lib', 'client.js')): ClientBundleProbe {
  const source = fs.readFileSync(bundlePath, 'utf8')
  const registrations: { id: string; factory: (require: (spec: string) => unknown) => unknown }[] = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration: { id: string; factory: (require: (spec: string) => unknown) => unknown }): void {
        registrations.push(registration)
      },
    },
  }
  // 基线模块替身：react 与宿主 primitives 给最小结构（不渲染组件，只验证注册链）
  const baseline: Record<string, unknown> = {
    react: {
      createElement: (type: unknown, props?: unknown, ...children: unknown[]) => ({ type, props, children }),
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: () => {},
    },
    // 官方控件原子（宿主自带；本插件只用到 Input / Button）
    '@deepseek-ai/dsh-client-ui-primitives': {
      Input: (props: unknown) => ({ type: 'Input', props }),
      Button: (props: unknown) => ({ type: 'Button', props }),
    },
  }
  const requireFrom = (spec: string): unknown => {
    if (!(spec in baseline)) throw new Error(`probe: unexpected require(${JSON.stringify(spec)})`)
    return baseline[spec]
  }

  // 执行 bundle：只注册工厂（与浏览器内核一致，模块体不跑）
  new Function('window', 'require', source)(fakeWindow, requireFrom)
  if (registrations.length !== 1) throw new Error(`应有且仅有 1 次 __ModuleLoader__.load，实际 ${String(registrations.length)}`)
  const registration = registrations[0]!

  // 物化：跑 factory，模块体此时才执行
  const exportsOf = registration.factory(requireFrom) as { apply?: unknown; inject?: unknown }
  if (typeof exportsOf.apply !== 'function') throw new Error('exports.apply 必须是函数')

  const registered: unknown[] = []
  let formEntryId = ''
  // 0.2.1 的 ConfigForm 替身：只给 apply 阶段会用到的最小面（组件不渲染）
  const form = {
    getSnapshot: () => ({
      status: 'ready',
      value: { enabled: true, root: '', recordSubagents: false, toolArgsPreview: 40, emptyIndex: false },
      revision: 0,
      writable: true,
    }),
    subscribe: () => () => {},
    set: async (): Promise<boolean> => true,
  }
  const fakeCtx = {
    slots: {
      inject: (name: string, callback: () => unknown): void => {
        if (name !== 'settings.section') throw new Error(`slots.inject 应注册 settings.section，实际 ${name}`)
        callback()
      },
      register: (definition: unknown): (() => void) => {
        registered.push(definition)
        return () => {}
      },
    },
    configForms: {
      get: (entryId: string) => {
        formEntryId = entryId
        return form
      },
    },
  }
  ;(exportsOf.apply as (ctx: unknown) => void)(fakeCtx)
  if (registered.length !== 1) throw new Error(`应注册 1 个 settings.section 槽，实际 ${String(registered.length)}`)
  const definition = registered[0] as {
    name?: string
    id?: string
    label?: () => string
    locale?: string
    inject?: () => unknown
  }
  if (definition.name !== 'settings.section') throw new Error(`槽 name 应为 settings.section，实际 ${String(definition.name)}`)
  if (definition.id !== 'conversationRecorder') throw new Error(`槽 id 应为 conversationRecorder，实际 ${String(definition.id)}`)
  if (typeof definition.label !== 'function') throw new Error('槽必须带 label')
  if (typeof definition.inject !== 'function') throw new Error('槽必须带 inject')

  const inject = Array.isArray(exportsOf.inject) ? (exportsOf.inject as readonly string[]) : []
  return {
    bundlePath,
    bytes: source.length,
    registrations: registrations.map((item) => item.id),
    exportKeys: Object.keys(exportsOf),
    inject,
    section: {
      name: definition.name,
      id: definition.id,
      label: definition.label(),
      locale: typeof definition.locale === 'string' ? definition.locale : '',
    },
    injectFaceKeys: Object.keys(definition.inject() as object),
    formEntryId,
    source,
  }
}
