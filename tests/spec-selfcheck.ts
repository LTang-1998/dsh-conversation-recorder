/**
 * SPEC.md 结构自检（任务1 验收）：用 node:assert 逐条核对契约文本结构。
 * 运行：node tests/spec-selfcheck.ts
 * 只校验结构，不校验实现（实现由 tests/run.ts 覆盖）。
 *
 * 2026-09-10 任务1：判据**随契约同步**（不放松）——
 *   · 删掉已从契约移除的字段检查（轮次表 summary 列、轮次 frontmatter 的 links/files、字段表对应行）；
 *   · 新增更强的负向检查：这些字段不得再以任何形式出现在 SPEC 中；
 *   · 新增新增节/新语义的检查（UTC、配置节、fork 基点、agent-message、session/disposed、resume 回填、callId 来源）。
 */

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const spec = fs.readFileSync(path.join(repo, 'SPEC.md'), 'utf8')

const missing: string[] = []

function must(needle: string, label: string): void {
  if (!spec.includes(needle)) missing.push(`${label} 缺少: ${JSON.stringify(needle)}`)
}

/** 负向检查：契约里已删除的东西不得复活。 */
function forbid(needle: string, label: string): void {
  if (spec.includes(needle)) missing.push(`${label} 不该出现: ${JSON.stringify(needle)}`)
}

/** 按行核对（比全文 contains 更严：字面量必须出现在某一行的指定位置）。 */
function mustLine(label: string, needle: string, re: RegExp): void {
  if (!spec.split('\n').some((line) => re.test(line))) {
    missing.push(`${label} 缺少按行命中的: ${needle}`)
  }
}

// 布局
must('_conversations/<工作区文件夹>/<sessionId>/{index.md,turns/NNNN.md}', '布局')
must('index.md', 'index 文件')
must('turns/', '轮次目录')

// index frontmatter 字段（沿用 SPEC §3.1 字段序；ended/state 已按上一轮任务删除）
for (const f of ['title', 'session', 'started', 'model', 'turns', 'fork_from']) {
  must(f, `index frontmatter 字段 ${f}`)
}

// 轮次表列（2026-09-10：summary 列已删除，表头必须是三列）
for (const c of ['seq', 'time', 'kind']) {
  must(c, `轮次表列 ${c}`)
}
must('| seq | time | kind |', '轮次表三列表头')

// 轮次 frontmatter 字段（links/files 已删除）
for (const f of ['session', 'seq', 'time', 'kind', 'prev']) {
  must(f, `轮次 frontmatter 字段 ${f}`)
}
must('callId', 'callId 内联引用')
must('message.toolCallId ?? message.source.callId', 'callId 取自 tool/result 的 toolCallId ?? source.callId（v4 形状）')

// 已删除字段的负向检查（判据同步且更严）
forbid('| summary |', '轮次表 summary 列')
forbid('summary', 'summary 概念（已整列删除）')
forbid('links: []', '轮次 frontmatter links')
forbid('files: []', '轮次 frontmatter files')
forbid('| links |', '字段表 links 行')
forbid('| files |', '字段表 files 行')
forbid('ended', 'index frontmatter ended（上一轮已删）')

// 时间制式：全 UTC
must('UTC', '时间统一 UTC')

// prev 规则
must('跨会话', 'prev 跨会话')
must('../<父会话id>/turns/NNNN.md', 'prev 跨会话格式')

// fork 规则（2026-09-10：基点 = 本进程首个 turn/start 的 turn − 1；@引用路径 base=0）
// 2026-09-15（0.3.0 任务1）锚点换新（旧→新逐条登记在 PROGRESS.md）：
//  旧判据：must('F+1', 'fork seq 从 fork 点+1 起')   ← 与「seq 恒等于已落盘轮次数 + 1」同属旧口径，已删
//  新判据：（无新增字面量）「基点只用于首轮 `prev`」这条原样保留——新规则下基点 F 同样只参与首轮 prev 的寻址，
//          seq 一律按 §6 总则（磁盘最大序号 + 1）算，故本条判据不需要改口径，只是语义更干净：fork 首轮从 1 起。
must('fork 点', 'fork 点')
must('基点只用于首轮 `prev`', 'fork 基点只用于首轮 prev 的寻址')
must('本进程首个', 'fork 基点取本进程首个 turn/start')
must('seq <= 0', '负/零序号拒绝落盘')
must('session-reference', '@引用 fork 路径')

// resume 自愈 + 内存回收 + 用户小节来源
must('回填', 'resume 自愈回填 turns/title/model')
must('session/disposed', 'session/disposed 内存回收')
must('agent-message', '## user 收录 agent-message')
must('（无用户文本）', '无用户文本占位语义')

// 配置节
must('## 8. 配置', '配置节')
must('root', 'root 配置项')
must('dsh-conversation-recorder', '设置命名空间 dsh-conversation-recorder')

// 2026-10-19：0.2.1 的 Config 模型（旧「设置注册 + 三层解析」已删）
must('根解析顺序', '根解析顺序小节')
// 内置默认根：**按行**核对「Config 一层 + 内置默认」两层，避免别处出现同一字面量时漏检
mustLine('[根解析顺序]', '根解析顺序小节', /^1\. 插件 `Config` 的 `root`/)
mustLine('[内置默认根]', '内置默认根 $DSH_HOME/_conversations', /^3\. 内置默认 `\$DSH_HOME\/_conversations`/)
must('resolveDshHome()', '默认根按 resolveDshHome() 语义解析')
must('config.root.get()', 'root 从 Config 的 getter 读')
must('`Config`', '插件导出 Config')
must('.volatile()', '五个字段都用 .volatile()（稳定引用）')
must("settings.configure({ auto: false }", 'apply 用 settings.configure({auto:false}) 接线')
must('configForms', '客户端用 configForms 服务')
must('ctx.configForms.get', '客户端按条目 id 取 ConfigForm')
must('form.set(field, value)', '客户端逐字段 form.set 写入')
forbid("applies: 'live'", '旧的 applies: live 注册模型')
forbid('remote.settings', '旧的 remote.settings 通道')
forbid('remote-envelope', '旧的 remote-envelope 解包模块')
must('不用重启', '改设置即时生效、不用重启')
for (const f of ['recordSubagents', 'toolArgsPreview', 'emptyIndex']) {
  must(f, `设置字段 ${f}`)
}
must('0–200', 'toolArgsPreview 取值域 0–200')
must('@deepseek-ai/dsh-home-paths', '放行宿主 peer dsh-home-paths')
must('@deepseek-ai/schemastery', '放行宿主 peer schemastery')

// 2026-09-15（0.3.0 任务1）：seq = 磁盘上已存在的最大序号 + 1（**唯一契约变更**，见 PROGRESS.md 旧→新登记）
//  旧判据：must('已落盘的轮次数 + 1', 'seq 恒等于已落盘轮次数 + 1')        ← 个数口径，会让被跳过的轮次卡死后续记录
//  新判据：must('磁盘上已存在的最大序号 + 1', …)                             ← 取最大值口径，无洞时与旧规则逐字等价
//          + must('逐字等价', …)（无洞等价这条关系本身也是契约文本）
//          + must('不做停摆检测', …)（明确不做的范围）
// 判据是**同步**（不放松）：新增了 3 条，只改这一条的口径；「漏掉一轮后继续」「基点只用于首轮 prev」原样保留。
must('磁盘上已存在的最大序号 + 1', 'seq = 磁盘上已存在的最大序号 + 1')
must('逐字等价', '无洞时与「已落盘轮次数 + 1」逐字等价')
must('不是「已落盘轮次数 + 1」', '契约写明旧口径不再使用')
must('不做停摆检测', '不做停摆检测')
must('基点只用于首轮 `prev`', 'fork 基点只用于首轮 prev')
must('漏掉一轮后继续', '漏掉一轮后继续仍只会向前写')

// 2026-09-15 任务3：工作区名同时把 `/` 当作分隔符
must('`/` 换成 `-`', '正斜杠也当分隔符')

// 2026-09-16（0.3.0 任务2）：产物文档一节（只缺则写、生成标记、AGENTS ≤2KB、enabled=false 不写）
must('## 10. 产物文档', '产物文档小节')
must('<!-- generated by dsh-conversation-recorder -->', '生成标记字面量')
must('只缺则写', '产物文档「只缺则写」口径')
must('手写文件', '手写文件不许改写')
must('2048', 'AGENTS.md ≤2048 字节')
must('ensureRootDocs', '产物文档实现入口 ensureRootDocs')

// 2026-09-16（0.3.0 任务5）：发布一致性门禁一节
must('## 11. 发布一致性门禁', '发布一致性门禁小节')
must('verify:privacy', '隐私门禁命令')
must('pnpm verify', '构建一致性门禁命令')
must('与 `src/` 一致', 'lib 与 src 一致性判据')

// 子代理过滤
must("origin === 'subagent'", '子代理过滤')

// 工具清单行格式
must('- [', '工具清单行前缀')
must('前40', '参数前 40 字')
must('结果', '结果行数')
must('[error:', 'error code')
must("type === 'text'", '结果文本取 content 里的 text 块（v4 无 tool-result 包壳）')

// 契约字段表区块标记（只在独立行取，避免文中内联代码里的同名标记干扰）
const begin = spec.indexOf('\n<!-- CONTRACT-FIELDS-BEGIN -->')
const end = spec.indexOf('\n<!-- CONTRACT-FIELDS-END -->')
assert(begin !== -1 && end !== -1 && end > begin, 'CONTRACT-FIELDS 区块标记缺失或顺序错误')

// 字段表区块内容：必须包含全部契约字段（summary/links/files 已删除）
const block = spec.slice(begin, end)
for (const f of ['title', 'session', 'started', 'model', 'turns', 'fork_from', 'seq', 'time', 'kind', 'prev', 'callId']) {
  if (!block.includes(`| ${f} |`)) missing.push(`字段表区块缺少 ${f}`)
}
for (const f of ['summary', 'links', 'files']) {
  if (block.includes(`| ${f} |`)) missing.push(`字段表区块不该再有 ${f}`)
}

if (missing.length > 0) {
  console.error('SPEC.md 自检失败（红）：')
  for (const m of missing) console.error(`  - ${m}`)
  process.exit(1)
}

console.log('SPEC.md 自检全绿（绿）：布局/frontmatter/三列轮次表/prev/fork 基点/子代理过滤/工具行/UTC/配置/resume 回填/字段表区块 全部命中，已删字段无一复活。')
console.log(`区块标记: CONTRACT-FIELDS-BEGIN@${begin} / END@${end}`)
