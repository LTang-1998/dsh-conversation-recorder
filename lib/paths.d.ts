/**
 * dsh-conversation-recorder —— 路径与时间。
 *
 * root 解析（设置 → 配置 → 内置 `$DSH_HOME/_conversations`）、会话目录名安全化、轮次文件名、
 * 全契约统一的 UTC 时间。零运行时依赖：仅 node 内置。
 */
/** 插件配置：五个字段都可以缺（缺哪层就往下一层退，见 SPEC §8）。 */
export interface RecorderConfig {
    /** 总开关（默认 true）；false 时引擎不产出任何新文件，已有记录不动。 */
    readonly enabled?: boolean;
    /** 记录根目录（即 `_conversations` 目录本身）；空/未配置 → 设置层 → 内置默认根。 */
    readonly root?: string;
    /** 是否也记录子代理会话；默认 false。 */
    readonly recordSubagents?: boolean;
    /** 工具清单行参数预览字数（0–200）；默认 40。 */
    readonly toolArgsPreview?: number;
    /** 元数据事件是否也建目录并写 index；默认 false。 */
    readonly emptyIndex?: boolean;
}
/** 默认记录目录名（跟在 `$DSH_HOME` 后面）。 */
export declare const CONVERSATIONS_DIR = "_conversations";
/** 会话 cwd 缺失/为空时的兜底工作区文件夹名。 */
export declare const UNGROUPED_DIR = "\u672A\u5206\u7EC4";
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
export declare function workspaceDir(cwd: string | undefined): string;
/** 4 位零填充轮次文件名序号（0001.md …）。 */
export declare function seqFile(seq: number): string;
/**
 * 会话 id 作为目录名时防路径穿越：`''`、`'.'`、`'..'` 一律拒绝（抛错），
 * 其余字符只允许 `[A-Za-z0-9._-]`（其余替换为 `_`）。
 */
export declare function safeSessionDir(id: string): string;
/** ISO 8601 UTC 时间（毫秒精度，`Z` 结尾）——契约里所有时间字段统一用它。 */
export declare function isoNow(): string;
/** epoch 毫秒 → ISO 8601 UTC。 */
export declare function isoFromEpochMs(ms: number): string;
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
export declare function resolveRoot(settingsRoot: string | undefined, configRoot: string | undefined, fallback: string): string;
