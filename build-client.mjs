/**
 * 构建客户端半边：`src/client/index.ts` → `lib/client.js`（浏览器加载格式）。
 *
 * 为什么这么做（不新增打包器依赖，任务书唯一允许的路径）：
 *   - 浏览器侧要的是**一个自注册 bundle**：`window.__ModuleLoader__.load({ id, factory })`，
 *     其中 `factory(require)` 返回 exports（与 `dsh-session-bin` 的 `lib/client.js` 同形状）；
 *   - 本仓库的构建工具只有 `tsc`（devDependency），不引入 esbuild/rollup/vite ——
 *     故用 `tsc` 把客户端源码编成 CJS，再套一层薄脚手写成上面的握手；
 *   - `react` 与 `@deepseek-ai/*` 保持外部（`require("react")` 由 shell 的基线模块表回答），
 *     不在产物里内联任何宿主库。
 *
 * 相对模块（`src/client/*.ts`，例如 `remote-envelope.ts`）：`tsc --noResolve` 只按文件列表
 * 编译、不解析 import，直出的 CJS 里相对 `require("./x")` 会在浏览器里解析不到。故这里把
 * 同目录的每个客户端模块都编一遍，再装进 bundle 内部的**小模块表** `__modules`，
 * 由 `__localRequire` 先查表、查不到才交给 shell 的 `require`（即宿主基线模块）。
 *
 * 用法：node build-client.mjs（由 build.mjs 调用）
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tsc = path.join(here, 'node_modules', 'typescript', 'lib', 'tsc.js')
const outDir = path.join(here, 'lib')
const tmp = path.join(here, '.client-build-tmp')
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))

const clientDir = path.join(here, 'src', 'client')
const entry = 'index.ts'
// 客户端源码模块（不含 .d.ts 类型环境；类型环境单独传给 tsc 当根文件）
const modules = fs.readdirSync(clientDir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
  .sort()
if (!modules.includes(entry)) {
  console.error(`build-client FAILED: 找不到入口 ${entry}（src/client 下：${modules.join(', ')}）`)
  process.exit(1)
}

// 1) tsc 编成 CJS（不解析 import：react/@deepseek-ai 保持外部，运行时不内联）
//    类型环境用**入库的** `src/client/env.d.ts`（声明 react 与宿主 primitives 的用到面；
//    运行时仍是 shell 基线里的真实现，产物里不内联任何宿主库），与 tsconfig.client.json 同一份。
const envTypes = path.join(clientDir, 'env.d.ts')
const args = [
  tsc,
  '--module', 'commonjs',
  '--target', 'es2022',
  '--noResolve',
  '--skipLibCheck',
  '--outDir', tmp,
  ...modules.map((name) => path.join(clientDir, name)),
  envTypes,
]

fs.rmSync(tmp, { recursive: true, force: true })
execFileSync(process.execPath, args, { cwd: here, stdio: 'inherit' })

/** 编译产物 → 模块体内文。 */
function emitted(name) {
  const file = path.join(tmp, name.replace(/\.ts$/, '.js'))
  if (!fs.existsSync(file)) {
    console.error(`build-client FAILED: tsc 没有产出 ${file}`)
    process.exit(1)
  }
  return fs.readFileSync(file, 'utf8')
}

const body = emitted(entry)
// 相对模块表：spec 用「不带扩展名」的写法（与源码 import 一致，见 index.ts 注释）
const registry = modules
  .filter((name) => name !== entry)
  .map((name) => {
    const spec = `./${name.replace(/\.ts$/, '')}`
    return `${JSON.stringify(spec)}: function (module, exports, require) {\n${emitted(name)}\n}`
  })
  .join(',\n')

// 入口模块体整段包进一个本地函数，形参就取名 `require` —— 这样入口产物里的
// `require("react")` 字面量原样保留（宿主基线模块），只有相对模块会被 __localRequire 命中模块表。
const prelude =
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { ` +
  'var __modules = {\n' + registry + '\n};\n' +
  'var __cache = {};\n' +
  'function __localRequire(spec) {\n' +
  '  if (!Object.prototype.hasOwnProperty.call(__modules, spec)) return require(spec);\n' +
  '  if (__cache[spec]) return __cache[spec].exports;\n' +
  '  var m = { exports: {} };\n' +
  '  __cache[spec] = m;\n' +
  '  __modules[spec](m, m.exports, __localRequire);\n' +
  '  return m.exports;\n' +
  '}\n' +
  'var module = { exports: {} }; var exports = module.exports;\n' +
  '(function (module, exports, require) {\n'
const postlude = '\n})(module, exports, __localRequire);\nreturn module.exports;\n} });\n'

// 相对模块走模块表、宿主模块落回 shell require（入口模块体一字未改）
const bundle = prelude + body + postlude

// 防呆：产物必须是自注册 bundle，且没有把宿主库内联/打进产物
if (!bundle.includes('__ModuleLoader__.load')) {
  console.error('build-client FAILED: 产物缺少 window.__ModuleLoader__.load 握手')
  process.exit(1)
}
if (!bundle.includes('require("react")') && !bundle.includes("require('react')")) {
  console.error('build-client FAILED: 产物里没有 require("react") —— react 必须保持外部')
  process.exit(1)
}
if (!bundle.includes('require("@deepseek-ai/dsh-client-ui-primitives")') && !bundle.includes("require('@deepseek-ai/dsh-client-ui-primitives')")) {
  console.error('build-client FAILED: 产物里没有 require("@deepseek-ai/dsh-client-ui-primitives") —— 宿主 primitives 必须保持外部')
  process.exit(1)
}
// 相对模块必须全部装进本地模块表：入口产物里出现的相对模块名都要在 __modules 里有定义
for (const match of bundle.matchAll(/\brequire\(\s*"(\.[^"]*)"\s*\)/g)) {
  const spec = match[1]
  if (!registry.includes(`${JSON.stringify(spec)}:`)) {
    console.error(`build-client FAILED: 产物 require(${spec}) 不在 __modules 模块表里 —— 浏览器解析不到`)
    process.exit(1)
  }
}
if (modules.length < 2) {
  console.error('build-client FAILED: 本地模块表为空（应至少含 remote-envelope）')
  process.exit(1)
}

fs.writeFileSync(path.join(outDir, 'client.js'), bundle, 'utf8')

// 类型桩：客户端半边的 `exports["./client"].types` 必须存在（产物是手写脚手 + CJS，本体没有 d.ts）
fs.writeFileSync(
  path.join(outDir, 'client.d.ts'),
  [
    '/** dsh-conversation-recorder 客户端半边（`lib/client.js` 的类型桩）。 */',
    'export declare const inject: readonly string[]',
    'export declare function apply(ctx: unknown): void',
    '',
  ].join('\n'),
  'utf8',
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`build-client: lib/client.js 产出（${String(bundle.length)} 字节；本地模块表 ${String(modules.length - 1)} 个，外部依赖保持 require，不内联宿主库）+ lib/client.d.ts 类型桩`)
