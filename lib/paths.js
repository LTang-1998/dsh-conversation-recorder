/**
 * dsh-conversation-recorder —— 路径与时间。
 *
 * root 解析（设置 → 配置 → 内置 `$DSH_HOME/_conversations`）、会话目录名安全化、轮次文件名、
 * 全契约统一的 UTC 时间。零运行时依赖：仅 node 内置。
 */
import * as os from 'node:os';
import * as path from 'node:path';
/** 默认记录目录名（跟在 `$DSH_HOME` 后面）。 */
export const CONVERSATIONS_DIR = '_conversations';
/** 会话 cwd 缺失/为空时的兜底工作区文件夹名。 */
export const UNGROUPED_DIR = '未分组';
/** 需要逐字符转义成 `~XXXX` 的 ASCII 字符（Windows 非法字符 + Obsidian 保留字符 + `~` 自身）。 */
const ESCAPED_ASCII = new Set(['*', '?', '"', '<', '>', '|', '#', '^', '[', ']', '~']);
/** UTF-16 码元 → 4 位大写十六进制（`~XXXX` 里的 XXXX）。 */
function hex4(code) {
    return code.toString(16).toUpperCase().padStart(4, '0');
}
/**
 * 会话 cwd → 工作区文件夹名（记录根下的第一级目录，见 SPEC §2）。
 *
 * 规则（逐字照契约）：
 *  ① `cwd` 缺失或为空 → `未分组`；
 *  ② 去掉 `:`，把 `\` 与 `/` 都换成 `-`；
 *  ③ 每个**连续非 ASCII 段**保留可读形式，紧跟该段每个 UTF-16 码元的 `~XXXX`（4 位大写）；
 *  ④ 其余 `* ? " < > |`、`# ^ [ ]`、`~` 各转义成 `~XXXX`；
 *  ⑤ 结果为空的兜底 → `未分组`。
 *
 * 例：`D:\我的笔记` → `D-我的笔记~6211~7684~7B14~8BB0`；`D:\示例` → `D-示例~793A~4F8B`。
 * 纯函数、零副作用（同 cwd 永远得同一个名字，便于历史记录按名字归位）。
 */
export function workspaceDir(cwd) {
    if (cwd === undefined || cwd === '')
        return UNGROUPED_DIR;
    const flat = cwd.replace(/:/g, '').replace(/[\\/]/g, '-');
    let out = '';
    let i = 0;
    while (i < flat.length) {
        const code = flat.charCodeAt(i);
        if (code > 0x7f) {
            // ③ 连续非 ASCII 段：先原样保留，再逐码元补 ~XXXX
            let run = '';
            while (i < flat.length && flat.charCodeAt(i) > 0x7f) {
                run += flat[i];
                i += 1;
            }
            out += run;
            for (let j = 0; j < run.length; j += 1) {
                out += '~' + hex4(run.charCodeAt(j));
            }
            continue;
        }
        // ④ 保留字符逐字符转义
        const ch = flat[i] ?? '';
        i += 1;
        out += ESCAPED_ASCII.has(ch) ? '~' + hex4(code) : ch;
    }
    return out === '' ? UNGROUPED_DIR : out;
}
/** 4 位零填充轮次文件名序号（0001.md …）。 */
export function seqFile(seq) {
    return String(seq).padStart(4, '0') + '.md';
}
/**
 * 会话 id 作为目录名时防路径穿越：`''`、`'.'`、`'..'` 一律拒绝（抛错），
 * 其余字符只允许 `[A-Za-z0-9._-]`（其余替换为 `_`）。
 */
export function safeSessionDir(id) {
    if (id === '' || id === '.' || id === '..') {
        throw new Error(`unsafe session id ${JSON.stringify(id)}`);
    }
    return id.replace(/[^A-Za-z0-9._-]/g, '_');
}
/** ISO 8601 UTC 时间（毫秒精度，`Z` 结尾）——契约里所有时间字段统一用它。 */
export function isoNow() {
    return new Date().toISOString();
}
/** epoch 毫秒 → ISO 8601 UTC。 */
export function isoFromEpochMs(ms) {
    return new Date(ms).toISOString();
}
/** 展开配置里开头的 `~`（家目录简写）。 */
function expandHome(value) {
    if (value === '~')
        return os.homedir();
    if (value.startsWith('~/') || value.startsWith('~\\'))
        return path.join(os.homedir(), value.slice(2));
    return value;
}
/**
 * 解析会话的记录根目录（即 `_conversations` 目录本身，其下是
 * `<工作区文件夹>/<sessionId>/` 两级，工作区文件夹名见 workspaceDir）。
 *
 * 三层优先（SPEC §2/§8）：设置里的 `root` → 配置的 `root` → 内置默认根。
 * 内置默认根本身由调用方传入（在 `settings.defaultRoot()` 里用宿主自带的 `resolveDshHome()` 算，
 * 本模块不 import DSH 包，保持「零运行时依赖」）。
 *
 * @param settingsRoot - 设置服务里的 root（最高优先）；空串视为未设置
 * @param configRoot - 装配配置（`apply(ctx, config)`）里的 root；空串视为未配置
 * @param fallback - 内置默认根（三层都没有值时用它）
 * @returns 解析后的记录根目录（支持开头 `~` 展开）
 */
export function resolveRoot(settingsRoot, configRoot, fallback) {
    const fromSettings = expandHome(trimmed(settingsRoot));
    if (fromSettings !== '')
        return fromSettings;
    const fromConfig = expandHome(trimmed(configRoot));
    if (fromConfig !== '')
        return fromConfig;
    return fallback;
}
/** 去空白；undefined → 空串（「这一层没有值」）。 */
function trimmed(value) {
    return value === undefined ? '' : value.trim();
}
