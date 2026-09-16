/**
 * 只读探针：验证「`<$DSH_HOME>/settings.yaml` 的 conversation-recorder.root
 * → 引擎三层解析 → 最终落点」这条链。
 *
 * 用法：node tests/probe-real-settings.ts
 * 说明：只读真实配置文件，不写任何记录；输出即证据（贴进交付）。
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRoot, workspaceDir } from '../src/paths.ts'
import { createSettingsSource, defaultRoot, SETTINGS_NAMESPACE } from '../src/settings.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME ?? ''
const settingsPath = path.join(home, 'settings.yaml')
let raw = ''
try {
  raw = readFileSync(settingsPath, 'utf8')
} catch {
  // settings.yaml 不存在或读不了 ⇒ 视为「本机没有声明值」，照常跑完（换台机器不再 ENOENT 崩）
  console.log('settings.yaml 不存在或不可读 → 视为本机没有声明值:', settingsPath)
}

const section = /^conversation-recorder:\n((?:[ \t]+.*\n?)*)/m.exec(raw)?.[1] ?? ''
const declaredRaw = /root:[ \t]*(.*)/.exec(section)?.[1]?.trim() ?? ''
const declared = declaredRaw.replace(/^['"]|['"]$/g, '')

console.log('settings.yaml 路径:', settingsPath)
console.log('该文件里的 recorder 段:', JSON.stringify(section))
console.log('声明值:', JSON.stringify(declaredRaw), '→', JSON.stringify(declared))
console.log('默认根 defaultRoot() =', defaultRoot())
console.log('resolveRoot(设置层=声明值, 配置层=无, 内置默认) =', resolveRoot(declared, undefined, defaultRoot()))
console.log('resolveRoot(设置层=空, 配置层=无, 内置默认) =', resolveRoot(undefined, undefined, defaultRoot()))
console.log('同一 cwd 的工作区文件夹名示例:', workspaceDir('D:\\知识库'))
console.log(
  '因此本机落点形如:',
  path.join(resolveRoot(declared, undefined, defaultRoot()), workspaceDir('D:\\知识库'), '<sessionId>', 'turns', '0001.md'),
)

// 用假 provider 走一遍真实的 createSettingsSource（三层优先的真代码）
const provider = {
  register: () => ({ get: () => ({ root: declared }), watch: () => () => {} }),
  get: () => ({ root: declared }),
}
console.log('createSettingsSource 解出的设置:', JSON.stringify(createSettingsSource({}, provider).current()))
const runtimeBare = [...readFileSync(path.join(repo, 'src', 'settings.ts'), 'utf8').matchAll(/^import [^']*from '([^']+)'/gm)]
  .map((match) => match[1])
  .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'))
console.log('设置命名空间:', SETTINGS_NAMESPACE, '| settings.ts 运行时裸包名（SPEC §9 白名单恰好两项）:', JSON.stringify(runtimeBare))
