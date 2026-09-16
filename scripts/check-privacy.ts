/**
 * 隐私门禁：仓库里不许出现本机路径与真实会话 id（发布到 GitHub 前的最后一道闸）。
 *
 * 判据：在入库的文本文件里搜下面三类串，命中任意一个即 exit 1（并把命中位置打出来）：
 *   ① 任何盘符的用户目录路径（Windows；大小写不敏感，正/反斜杠都认）
 *   ② POSIX 用户目录下的绝对路径（macOS 与 Linux），即根斜杠加系统用户目录段加斜杠、再跟一个字符
 *   ③ 真实会话 id：session- 加 8 位十六进制加连字符
 *
 * **判据只收「带真实路径的形态」**：两条路径规则都要求出现真实分隔符，因此对散文与示例零误报。
 * 因此**不查**波浪号家目录简写（`~/`，本身不含用户名，是本仓库规定的正规表达，见 SPEC §2/§8），
 * 也**不查**用户目录环境变量（`%USERPROFILE%` 这类名字只出现在文档与示例里，查它只会把
 * 「正在描述本规则」的文档报红）。理由详见规则列表末尾的注释。
 *
 * **规则里不写死任何用户名**（2026-09-16 修订）：旧实现把本机用户名当字面量钉在规则 ① 里，
 * 于是它只认那一台机器那一个用户名——换机器/换用户名，这条判据就形同虚设，而门禁的输出却是
 * 「通过（绿）」，会把「没检出」误读成「没有」。现在按「系统用户目录前缀」这一形态判，
 * 与具体是谁无关。代价是 `Public` / `Default` 这类系统自带目录也会被报出来：此类串出现在
 * 本仓库里同样不正常，一律改掉即可，不值得为它加白名单。
 *
 * 排除：版本库元数据目录、依赖目录、测试沙箱、二进制文件，以及本脚本自身
 * （它必须引用这些模式才能检查它们，否则会自命中）。
 *
 * 为什么要单独一个脚本而不是塞进测试：发布一致性门禁需要在 CI 里独立跑（见 SPEC §11），
 * 且它的判据是「仓库里所有文本文件」，与单测的沙箱无关。
 *
 * 用法：
 *   node scripts/check-privacy.ts              # 扫全仓（CI 与 pnpm verify:privacy 走这条）
 *   node scripts/check-privacy.ts <文件> …     # 只扫指定文件（反向验证取证用）
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 反斜杠用字符码拼：Node 的 TypeScript 类型剥离器对「正则字面量里的连续反斜杠」有歧义
// （会当成未终止的模板串）。拆成字符码没有任何歧义，匹配行为完全一致。
const BACKSLASH = String.fromCharCode(92)

interface Rule {
  readonly pattern: RegExp
  readonly label: string
}

const RULES: readonly Rule[] = [
  // ① Windows：盘符 + 用户目录段（用户名是谁一概不问）。分隔符用字符类，正斜杠一并认下。
  //    本文件自己会被扫到，所以下面这些模式**不能**写成「用户目录段后紧跟两个反斜杠」——
  //    那种字面量正好被本规则自己命中（本文件名在 SELF 排除名单里，但注释与规则仍在同一文件）。
  //
  //    **分隔符字符类必须写 BACKSLASH + BACKSLASH + '/'**（拼出 `[\\/]`）：少一个 BACKSLASH 会拼出
  //    `/` 前面的 `\/`，而正则在字符类外把 `\/` 读成「转义的斜杠」⇒ 该类只剩正斜杠一个成员，
  //    Windows 路径（反斜杠）全漏——本规则第一版就是这么写的，反向验证时才发现（单/双反斜杠都漏，
  //    只有正斜杠能命中）。两处分隔符都不许少。
  {
    pattern: new RegExp(
      '[A-Za-z]:[' + BACKSLASH + BACKSLASH + '/]+Users[' + BACKSLASH + BACKSLASH + '/]',
      'i',
    ),
    label: '盘符加用户目录路径',
  },
  // ② macOS / Linux：根斜杠 + 两个系统用户目录名。先拼出「斜杠 + 目录名」再交给 RegExp，
  //    这样源码里不会出现裸的「反斜杠 + 小写 u」——类型剥离器会把它当 Unicode 转义的开头，
  //    直接报 Unterminated template（本文件当初为此返工过一次）。
  {
    pattern: new RegExp(BACKSLASH + '/(Users|home)' + BACKSLASH + '/'),
    label: 'POSIX 用户目录路径',
  },
  // **为什么不查「用户目录环境变量」（%USERPROFILE% / $HOME 这类）**：那类变量名出现在
  // 文档、示例配置、命令片段里是正常写法，本身不含任何机器特定的东西——查它只会命中
  // 「正在描述这条规则」的文档（本规则试过一版，SPEC/README/CHANGELOG 全被自己报红）。
  // 判据只留「带真实路径的形态」：盘符用户目录 ① 与 POSIX 家目录 ②，二者都要求出现
  // 真实分隔符，因此对散文零误报。宁可少一条泛化规则，也不要一条会长期假红的规则。
  { pattern: /session-[0-9a-f]{8}-/, label: '真实会话 id（8 位十六进制前缀）' },
]

/** 不参与扫描的目录名（任意层级）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm-store', '.client-build-tmp'])
/** 只扫文本类扩展名（二进制文件不参与，避免乱码误判）。 */
const TEXT_EXT = new Set([
  '.md', '.ts', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.yaml', '.yml',
  '.txt', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.html', '.css', '.patch',
])
/** 无扩展名的文本文件。 */
const TEXT_NO_EXT = new Set(['LICENSE', 'NOTICE', 'COPYING', '.gitignore', '.npmrc', '.gitattributes'])

const SELF = path.basename(fileURLToPath(import.meta.url))

interface Hit {
  readonly file: string
  readonly line: number
  readonly label: string
  readonly text: string
}

const hits: Hit[] = []

function scanFile(abs: string): void {
  const rel = path.relative(repo, abs).split(path.sep).join('/')
  if (rel.includes('tests/.tmp')) return
  const base = path.basename(abs)
  if (base === SELF) return
  const ext = path.extname(base).toLowerCase()
  if (!TEXT_EXT.has(ext) && !TEXT_NO_EXT.has(base)) return
  let text: string
  try {
    text = fs.readFileSync(abs, 'utf8')
  } catch {
    return
  }
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({ file: rel, line: i + 1, label: rule.label, text: line.trim().slice(0, 160) })
      }
    }
  }
}

function walk(dir: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.tmp')) continue
      walk(abs)
    } else if (entry.isFile()) {
      scanFile(abs)
    }
  }
}

// 默认扫整个仓库（CI 与 `pnpm verify:privacy` 走这条路）。带文件参数时**只扫这些文件**：
// 这条入口是给反向验证与本地取证用的——「换一个用户名还能不能报红」必须能拿一个合成的
// 外部文件直接问门禁，否则只能把违规串写进仓库再删，既繁琐又容易污染扫描结果。
// 注意：显式模式下仍会应用同一个 SELF 排除与扩展名过滤，判据与全仓扫描完全一致。
const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))

if (explicit.length > 0) {
  for (const arg of explicit) scanFile(path.resolve(arg))
} else {
  walk(repo)
}

if (hits.length > 0) {
  const total = String(hits.length)
  console.error('verify:privacy 失败（红）：命中 ' + total + ' 处不许公开的串')
  for (const hit of hits) {
    console.error('  - ' + hit.file + ':' + String(hit.line) + ' [' + hit.label + '] ' + hit.text)
  }
  process.exit(1)
}

console.log('verify:privacy 通过（绿）：仓库内无本机用户名路径、无盘符用户目录、无真实会话 id。')
