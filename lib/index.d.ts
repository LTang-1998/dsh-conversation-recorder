/**
 * dsh-conversation-recorder —— cordis 插件入口（薄壳）。
 *
 * 契约见 SPEC.md；布局 `<root>/<工作区文件夹>/<sessionId>/{index.md,turns/NNNN.md}`，其中 root 三层优先：
 * 设置里的 `root` → 配置的 `root` → 内置 `<$DSH_HOME>/_conversations`（见 SPEC §2/§8），工作区文件夹名由
 * 会话 cwd 按 SPEC §2 规则算出（`paths.workspaceDir`）。
 *
 * 模块分工：paths（root/目录名/时间）、format（md 渲染与回填读取）、seq（轮次序号规则）、
 * settings（宿主侧五个设置）、engine（事件引擎 + apply 接线）。本文件只做导出与插件名声明，
 * 自身**不含任何运行时 import**——
 * 这是 tests/run.ts 既有断言的硬要求（入口顶层只允许 `node:fs` / `node:path` 运行时导入，
 * 故兄弟模块只能经 `export … from` 暴露，见 PROGRESS.md 任务2）。
 */
export * from './paths.js';
export * from './format.js';
export * from './seq.js';
export * from './docs.js';
export * from './settings.js';
export * from './engine.js';
/** 插件名（dsh 读取本导出）。 */
export declare const name = "dsh-conversation-recorder";
