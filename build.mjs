/**
 * 构建脚本：tsc 直出 lib/（ESM js + d.ts），再把 **d.ts 内**的相对导入扩展名从 `.ts` 改写成 `.js`。
 *
 * 为什么需要这一步：
 *   - 源码（也是测试直接用 node 跑的入口）必须写 `./x.ts`——node 的类型擦除运行时不认识 `./x.js`
 *     指向 `.ts` 源文件，tests/run.ts 也直接 import `../src/index.ts`；
 *   - `tsc` 的 `rewriteRelativeImportExtensions` 只改写 JS 产物，**不改写 d.ts**（实测 TS 5.9.3）；
 *   - 于是 d.ts 里会残留 `from './paths.ts'`，发布给消费者（moduleResolution bundler/node16）无法解析。
 * 故构建后统一改写 d.ts 的相对说明符；只做扩展名替换，内容与结构不动。
 *
 * 用法：node build.mjs（= pnpm build）
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tsc = path.join(here, 'node_modules', 'typescript', 'lib', 'tsc.js')
const outDir = path.join(here, 'lib')

// 1) 类型检查 + 产出 lib/（js + d.ts）
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--pretty', 'false'], {
  cwd: here,
  stdio: 'inherit',
})

// 2) d.ts 内的相对导入/导出扩展名 .ts → .js
let patched = 0
for (const entry of fs.readdirSync(outDir)) {
  if (!entry.endsWith('.d.ts')) continue
  const file = path.join(outDir, entry)
  const before = fs.readFileSync(file, 'utf8')
  const after = before.replace(/((?:from|import)\s*\(?\s*')(\.\.?\/[^']*)\.ts(')/g, '$1$2.js$3')
  if (after !== before) {
    fs.writeFileSync(file, after, 'utf8')
    patched += 1
  }
}

// 3) 防呆：lib/ 里不许出现 .ts 源文件（发布树只应有 js + d.ts）
const strayTs = fs.readdirSync(outDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))
if (strayTs.length > 0) {
  console.error(`build FAILED: lib/ 出现 .ts 源文件（${strayTs.join(', ')}）——发布树只应含 .js 与 .d.ts`)
  process.exit(1)
}

// 4) 客户端半边：lib/client.js（浏览器加载格式；见 build-client.mjs）
execFileSync(process.execPath, [path.join(here, 'build-client.mjs')], { cwd: here, stdio: 'inherit' })

const js = fs.readdirSync(outDir).filter((n) => n.endsWith('.js'))
console.log(`build: lib/ 产出 ${js.length} 个 .js（${js.join(', ')}），改写 ${patched} 个 .d.ts 的相对扩展名`)
