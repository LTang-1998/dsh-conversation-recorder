/**
 * 只读探针：验证「本机声明的 `root` → `Config` 解析 → 最终落点」这条链。
 *
 * 0.2.1 起插件只认 `Config.root`；本探针读两处**只读**的本机来源，仅用于展示落点：
 *   1. `<$DSH_HOME>/settings.yaml.imported`（旧设置文件的归档，里面可能还有 `conversation-recorder.root`）；
 *   2. `<$DSH_HOME>/profiles/web/cordis.patch.yml` 里 `- id: dsh-conversation-recorder` 条目的 `config.root`。
 * 文件不存在/不可读就视为「本机没有声明值」，照常跑完（换台机器不崩）。
 *
 * 用法：node tests/probe-real-settings.ts
 * 说明：只读，不写任何记录、不改任何配置；输出即证据。
 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRoot, workspaceDir } from '../src/paths.ts'
import { Config, defaultRoot, SETTINGS_NAMESPACE } from '../src/settings.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME ?? ''

function readIfExists(file: string, label: string): string {
  try {
    const text = readFileSync(file, 'utf8')
    console.log(`${label} 存在:`, file)
    return text
  } catch {
    console.log(`${label} 不存在或不可读 → 视为本机没有声明值:`, file)
    return ''
  }
}

/** 从旧的 settings 段 / profile patch 条目里取 `root`（只读展示，不参与插件运行时）。 */
function declaredRoot(text: string, pattern: RegExp): string {
  const raw = pattern.exec(text)?.[1]?.trim() ?? ''
  return raw.replace(/^['"]|['"]$/g, '')
}

const imported = readIfExists(path.join(home, 'settings.yaml.imported'), 'settings.yaml.imported')
const importedSection = /^conversation-recorder:\n((?:[ \t]+.*\n?)*)/m.exec(imported)?.[1] ?? ''
const importedRoot = declaredRoot(importedSection, /^\s*root:[ \t]*(.*)$/m)

const patch = readIfExists(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'web profile cordis.patch.yml')
const patchBlock = /- id: dsh-conversation-recorder\n((?:[ \t]+.*\n?)*)/.exec(patch)?.[1] ?? ''
const patchRoot = declaredRoot(patchBlock, /^\s*root:[ \t]*(.*)$/m)

const declared = patchRoot !== '' ? patchRoot : importedRoot
console.log('旧 settings 段里的 root:', JSON.stringify(importedRoot))
console.log('profile patch 里的 root:', JSON.stringify(patchRoot), '（= 插件实际读的 Config.root 来源）')
console.log('本次探针采用:', JSON.stringify(declared) === '""' ? '（空 → 内置默认根）' : declared)
console.log('默认根 defaultRoot() =', defaultRoot())
console.log('Config({root}).root.get() =', Config({ root: declared }).root.get())
console.log('resolveRoot(Config.root, 内置默认) =', resolveRoot(declared, '', defaultRoot()))
console.log('同一 cwd 的工作区文件夹名示例:', workspaceDir('D:\\知识库'))
console.log(
  '因此本机落点形如:',
  path.join(resolveRoot(declared, '', defaultRoot()), workspaceDir('D:\\知识库'), '<sessionId>', 'turns', '0001.md'),
)

const runtimeBare = [...readFileSync(path.join(repo, 'src', 'settings.ts'), 'utf8').matchAll(/^import [^']*from '([^']+)'/gm)]
  .map((match) => match[1])
  .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('.'))
console.log('设置命名空间:', SETTINGS_NAMESPACE, '| settings.ts 运行时裸包名（SPEC §9 白名单恰好两项）:', JSON.stringify(runtimeBare))
