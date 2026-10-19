/**
 * 只读探针：验证 `lib/client.js` 的加载链（自注册 → 物化 → configForms 取表单 →
 * 注册 settings.section 槽），并按 2.0.0 契约断言关键字段；不满足即 exit 1。
 *
 * 用法：node tests/probe-client-bundle.ts
 * 说明：只读产物，不启动浏览器、不改任何文件；输出即证据。
 */
import assert from 'node:assert/strict'

import { probeClientBundle } from './client-bundle.ts'

const result = probeClientBundle()
console.log('bundle:', result.bundlePath, '| 字节:', result.bytes)
console.log('自注册 id:', result.registrations.join(', '))
console.log('exports 键:', result.exportKeys.join(', '))
console.log('inject 声明:', JSON.stringify(result.inject))
console.log('configForms 条目 id:', result.formEntryId)
console.log('注册的槽定义:', JSON.stringify(result.section))
console.log('槽 inject 面的键:', result.injectFaceKeys.join(', '))
console.log('产物是自注册 bundle:', result.source.includes('__ModuleLoader__.load'))
console.log('产物里 react 保持外部:', result.source.includes('require("react")'))
console.log('产物用 configForms:', result.source.includes('configForms'))
console.log('产物无 remote.settings:', !result.source.includes('remote.settings'))

// 2.0.0 契约（NS = profile 条目 id；inject 用 configForms；旧 remote.settings 通道已删）
assert.deepStrictEqual([...result.registrations], ['dsh-conversation-recorder'], '自注册 id 应为包名')
assert(result.inject.includes('configForms'), 'inject 必须含 configForms')
assert.strictEqual(result.formEntryId, 'dsh-conversation-recorder', 'configForms 条目 id 必须是 dsh-conversation-recorder')
assert.strictEqual(result.section.locale, 'dsh-conversation-recorder', '槽 locale 必须是 dsh-conversation-recorder')
assert(!result.source.includes('remote.settings'), '产物不得再出现 remote.settings')
assert(!result.source.includes('remote-envelope'), '产物不得再引用 remote-envelope')
console.log('PROBE OK：bundle 契约全部命中')
