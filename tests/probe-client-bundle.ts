/**
 * 只读探针：验证 `lib/client.js` 的加载链（自注册 → 物化 → 注册 settings.section 槽）。
 *
 * 用法：node tests/probe-client-bundle.ts
 * 说明：只读产物，不启动浏览器、不改任何文件；输出即证据。
 */
import { probeClientBundle } from './client-bundle.ts'

const result = probeClientBundle()
console.log('bundle:', result.bundlePath, '| 字节:', result.bytes)
console.log('自注册 id:', result.registrations.join(', '))
console.log('exports 键:', result.exportKeys.join(', '))
console.log('inject 声明:', JSON.stringify(result.inject))
console.log('注册的槽定义:', JSON.stringify(result.section))
console.log('槽 inject 面的键:', result.injectFaceKeys.join(', '))
console.log('挂载阶段 describe 调用次数（应为 0）:', result.describeCallsAtMount)
console.log('产物是自注册 bundle:', result.source.includes('__ModuleLoader__.load'))
console.log('产物里 react 保持外部:', result.source.includes('require("react")'))
