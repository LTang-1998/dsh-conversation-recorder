/**
 * dsh-conversation-recorder —— 客户端（浏览器）半边：注册设置页的「会话记录」分区。
 *
 * 0.2.1 的设置模型：宿主插件 `export const Config`，客户端通过 cordis 服务
 * `ctx.configForms.get(entryId)` 拿到本命名空间的一份表单（`ConfigForm`）：
 *   - 读：`form.getSnapshot()`（`status/value/revision/writable`），`form.subscribe()` 订阅替换；
 *   - 写：`form.set(field, value)`——revision、失败回读、写入排队都由宿主服务负责，
 *     客户端不再自己解信封、也不再自己猜版本号（旧的 settings remote 通道已删）。
 *
 * 命名空间 = profile 里的插件条目 id `dsh-conversation-recorder`（与宿主 `Config` 同名）。
 *
 * 观感：与官方「插件」分区同一套行/卡片语言 —— 控件全部来自宿主自带的
 * `@deepseek-ai/dsh-client-ui-primitives`（`Input` / `Button`），颜色、边框、层级全部走 DSH
 * 设计变量（`--dsw-alias-*`）；**没有裸 `<input>` / `<button>` / `<label>`**。
 *
 * 构建：本文件由 `build-client.mjs` 用 `tsc` 编成 CJS 再套浏览器加载握手写成 `lib/client.js`；
 * 类型环境见同目录 `env.d.ts`，独立门禁 `tsconfig.client.json`。客户端只有这一个本地模块，
 * 相对模块表允许为空。
 */

import { createElement, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'

/** 设置命名空间（与宿主 `src/settings.ts` 的 SETTINGS_NAMESPACE 一致）。 */
const NS = 'dsh-conversation-recorder'

/** 宿主 `ConfigForm` 的同步快照（只声明本插件用到的字段）。 */
interface ConfigFormSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: Record<string, unknown> | undefined
  readonly revision: number | undefined
  readonly writable: boolean
}

/** 宿主 `ConfigForm` 的读写面（revision/回读/排队都在宿主服务里）。 */
interface ConfigForm {
  getSnapshot(): ConfigFormSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<boolean>
}

/** 客户端语义上的「cordis 客户端上下文」：只声明本插件用到的部分。 */
interface ClientContext {
  slots: {
    inject(name: 'settings.section', callback: () => unknown): unknown
    register(definition: {
      name: 'settings.section'
      id: string
      order?: number
      label: () => string
      locale?: string
      inject: () => unknown
    }, component: unknown): unknown
  }
  configForms: {
    /** 按 profile 条目 id 取本插件配置的表单（宿主服务提供）。 */
    get(entryId: string): ConfigForm
  }
}

/** 本插件声明的五个设置（默认值仅用于快照到达前的回退显示）。 */
const DEFAULTS = {
  enabled: true,
  root: '',
  recordSubagents: false,
  toolArgsPreview: 40,
  emptyIndex: false,
} as const

type Field = keyof typeof DEFAULTS

const FIELDS = Object.keys(DEFAULTS) as Field[]

const LABELS: Record<Field, string> = {
  enabled: '启用记录',
  root: '记录根目录',
  recordSubagents: '也记录子代理会话',
  toolArgsPreview: '工具参数预览字数',
  emptyIndex: '元数据事件也建目录并写 index',
}

const DESCRIPTIONS: Record<Field, string> = {
  enabled: 'enabled；关闭后不再产出新文件，已有记录不动。',
  root: '记录根目录（root）；留空回退内置 <$DSH_HOME>/_conversations。',
  recordSubagents: 'recordSubagents；默认 false，只记顶层会话。',
  toolArgsPreview: 'toolArgsPreview；0–200，默认 40，超出由 schema 拒绝。',
  emptyIndex: 'emptyIndex；默认 false，只有首个内容轮次落盘才建目录。',
}

/* ---- 官方「插件」分区同一套行样式（全部走 DSH 设计变量） ---- */

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  maxWidth: 760,
  color: 'var(--dsw-alias-label-primary)',
} as const

const headingStyle = { margin: 0, fontSize: 18, fontWeight: 600 } as const
const introStyle = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } as const

function fieldStyle(first: boolean): Record<string, unknown> {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 0',
    borderTop: first ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
  }
}

const labelStyle = { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' } as const
const descriptionStyle = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' } as const
// 说明：**不给官方 `Input` 传 `style`** —— 外观交回官方控件；满宽由外层 `fieldStyle` 自然拉伸。
const footerStyle = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } as const

interface FormState {
  enabled: boolean
  root: string
  recordSubagents: boolean
  toolArgsPreview: number
  emptyIndex: boolean
}

function toForm(value: Record<string, unknown> | undefined): FormState {
  const source = value ?? {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
    root: typeof source.root === 'string' ? source.root : DEFAULTS.root,
    recordSubagents: typeof source.recordSubagents === 'boolean' ? source.recordSubagents : DEFAULTS.recordSubagents,
    toolArgsPreview: typeof source.toolArgsPreview === 'number' ? source.toolArgsPreview : DEFAULTS.toolArgsPreview,
    emptyIndex: typeof source.emptyIndex === 'boolean' ? source.emptyIndex : DEFAULTS.emptyIndex,
  }
}

/** 值 → 显示文本。 */
function display(field: Field, form: FormState): string {
  if (field === 'root') return form.root === '' ? '（未设置，用内置默认根）' : form.root
  if (field === 'toolArgsPreview') return `${String(form.toolArgsPreview)} 字`
  return form[field] === true ? '开' : '关'
}

/** 一行设置：标题 + 说明 + 控件（行样式照官方设置分区）。 */
function fieldRow(field: Field, first: boolean, control: unknown): unknown {
  return createElement(
    'div',
    { key: field, style: fieldStyle(first) },
    createElement('span', { style: labelStyle }, LABELS[field]),
    createElement('span', { style: descriptionStyle }, DESCRIPTIONS[field]),
    control,
  )
}

interface SectionProps {
  form?: ConfigForm
}

/** 设置分区组件（用 `createElement` 而不是 JSX：本文件是 .ts，构建只过 tsc）。 */
function Section(props: SectionProps): unknown {
  const form = props.form
  const [formState, setFormState] = useState<FormState>({ ...DEFAULTS })
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [writable, setWritable] = useState(false)
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)

  // 挂载即读快照值，并订阅宿主服务推送的替换（写入成功后宿主会推新快照）。
  useEffect(() => {
    if (form === undefined) {
      setLoadState('unavailable')
      return
    }
    const apply = (): void => {
      const snapshot = form.getSnapshot()
      setLoadState(snapshot.status)
      setWritable(snapshot.writable)
      if (snapshot.status === 'ready') setFormState(toForm(snapshot.value))
    }
    apply()
    return form.subscribe(apply)
  }, [form])

  const save = async (): Promise<void> => {
    if (form === undefined) return
    setNotice('保存中…')
    setFailed(false)
    try {
      const base = toForm(form.getSnapshot().value)
      const changed = FIELDS.filter((field) => base[field] !== formState[field])
      if (changed.length === 0) {
        setNotice('没有变化')
        return
      }
      const results: boolean[] = []
      for (const field of changed) results.push(await form.set(field, formState[field]))
      if (results.every(Boolean)) {
        setNotice(`已保存 ${String(changed.length)} 项（即时生效，不用重启）`)
      } else {
        setFailed(true)
        setNotice('保存被宿主拒绝（可能设置在别处已更新），请重试')
      }
    } catch (error: unknown) {
      setFailed(true)
      setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const toggle = (field: 'enabled' | 'recordSubagents' | 'emptyIndex') => (): void => {
    setFormState((previous) => ({ ...previous, [field]: !previous[field] }))
  }

  const ready = loadState === 'ready'
  const status = loadState === 'unavailable'
    ? '宿主没有暴露本插件的配置（记录行为不受影响）'
    : loadState === 'loading'
      ? '正在读取当前设置…'
      : notice

  const rows: unknown[] = [
    createElement('h2', { key: 'heading', style: headingStyle }, '会话记录'),
    createElement(
      'p',
      { key: 'intro', style: introStyle },
      '把每个会话记录成可读的 Markdown 链（index.md + turns/NNNN.md）。改完即时生效，不用重启。',
    ),
    fieldRow('root', true, createElement(Input, {
      value: formState.root,
      placeholder: '<$DSH_HOME>/_conversations',
      onChange: (event: { target: { value: string } }) => setFormState((previous) => ({ ...previous, root: event.target.value })),
    })),
    fieldRow('enabled', false, createElement(Button, {
      variant: 'outline',
      size: 'sm',
      'aria-pressed': formState.enabled,
      onClick: toggle('enabled'),
    }, display('enabled', formState))),
    fieldRow('recordSubagents', false, createElement(Button, {
      variant: 'outline',
      size: 'sm',
      'aria-pressed': formState.recordSubagents,
      onClick: toggle('recordSubagents'),
    }, display('recordSubagents', formState))),
    fieldRow('toolArgsPreview', false, createElement(Input, {
      type: 'number',
      min: 0,
      max: 200,
      value: formState.toolArgsPreview,
      onChange: (event: { target: { value: string } }) => setFormState((previous) => ({ ...previous, toolArgsPreview: Number(event.target.value) })),
    })),
    fieldRow('emptyIndex', false, createElement(Button, {
      variant: 'outline',
      size: 'sm',
      'aria-pressed': formState.emptyIndex,
      onClick: toggle('emptyIndex'),
    }, display('emptyIndex', formState))),
    createElement(
      'div',
      { key: 'footer', style: footerStyle },
      createElement(Button, { variant: 'primary', size: 'md', disabled: !ready || !writable, onClick: () => void save() }, '保存'),
      createElement(
        'span',
        { style: failed ? { color: 'var(--dsw-alias-label-error)' } : { color: 'var(--dsw-alias-label-tertiary)' } },
        status,
      ),
    ),
  ]
  return createElement('section', { style: sectionStyle }, ...rows)
}

/** 需要的客户端服务（cordis 客户端 fiber inject）。 */
export const inject = ['slots', 'configForms']

/** 挂载设置分区。整个函数包 try/catch：客户端半边失败不能让 GUI 起不来。 */
export function apply(ctx: ClientContext): void {
  try {
    const form = ctx.configForms.get(NS)
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'conversationRecorder',
          order: 55,
          label: () => '会话记录',
          locale: NS,
          // 组件通过 props.form 拿到本命名空间的 ConfigForm（读写都走宿主服务）
          inject: () => ({ form }),
        },
        Section,
      ),
    )
  } catch (error: unknown) {
    // 设置页是可选 UI：连槽都没挂上时页面上没有可显示的位置，只能记录；
    // 读写失败一律由上面的状态行显示在分区里。
    console.error('dsh-conversation-recorder: settings section mount failed', error)
  }
}
