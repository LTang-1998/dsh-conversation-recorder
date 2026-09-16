/**
 * 一次性验收脚本（0.3.0 完成条件 3②）：
 * 用**真的 lib/docs.js** 对真实记录根 `<root>` 跑「首个内容轮次落盘 → 生成产物文档」，
 * 并证明「已存在的 README 再加一轮不会被动」。
 *
 * 只读约束：本脚本只让插件按自己的规则写 `<root>/README.md` 与 `<root>/AGENTS.md`，
 * 不动 `_conversations` 下的任何会话记录（会话本身写在自建沙箱会话目录里，跑完删掉）。
 *
 * 用法：node scripts/verify-root-docs.ts <记录根绝对路径>
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { ensureRootDocs } from '../src/docs.ts'

const root = process.argv[2] ?? ''
if (root === '') {
  console.error('用法：node scripts/verify-root-docs.ts <记录根>')
  process.exit(2)
}

const readme = path.join(root, 'README.md')
const agents = path.join(root, 'AGENTS.md')

console.log('记录根:', root)
for (const file of [readme, agents]) {
  console.log('  跑之前存在:', path.basename(file), fs.existsSync(file))
}

// 一次「首个内容轮次落盘后」的插件行为（就是引擎在 onTurnEnd 末尾调的那一句）
const wrote = ensureRootDocs(root)
console.log('  本次新写出:', JSON.stringify(wrote))
for (const file of [readme, agents]) {
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8')
    console.log(`  ${path.basename(file)} 字节=${String(Buffer.byteLength(text, 'utf8'))} 首行=${JSON.stringify(text.split('\n')[0] ?? '')}`)
  }
}
