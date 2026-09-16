/**
 * dsh-conversation-recorder —— 契约文本的渲染与回填读取。
 *
 * 只有本模块知道 md 长什么样：index/轮次 frontmatter、三列轮次表、轮次正文，
 * 以及 resume 自愈需要的「从磁盘读回元数据」。渲染是纯函数，读取只读不写。
 */
/** 无用户文本时的占位行。 */
export declare const NO_USER_TEXT = "\uFF08\u65E0\u7528\u6237\u6587\u672C\uFF09";
/** 无 agent 回答时的占位行。 */
export declare const NO_ASSISTANT_TEXT = "\uFF08\u65E0\u6B63\u6587\uFF09";
/** 轮次表一行（从 turns/NNNN.md 读回的 time/kind）。 */
export interface TurnRow {
    readonly seq: number;
    readonly time: string;
    readonly kind: string;
}
/** index.md 的会话元数据。 */
export interface SessionMeta {
    readonly id: string;
    readonly title: string;
    readonly startedIso: string;
    readonly model: string;
    readonly turns: number;
    readonly forkFrom: string;
}
/** 轮次文件的全部内容来源。 */
export interface TurnContent {
    readonly session: string;
    readonly seq: number;
    readonly time: string;
    readonly kind: string;
    readonly prev: string;
    readonly userLines: readonly string[];
    readonly assistantLines: readonly string[];
    readonly refNote: string | null;
    readonly toolLines: readonly string[];
}
/** index.md frontmatter 读回值（读不到/坏文件 → null 字段为空串、turns 为 0）。 */
export interface IndexMeta {
    readonly title: string;
    readonly model: string;
    readonly forkFrom: string;
    readonly turns: number;
}
/** 轮次 frontmatter（字段：session/seq/time/kind/prev；契约已无 links/files）。 */
export declare function turnFrontmatter(turn: TurnContent): string[];
/** 轮次正文：## user（含引用行、工具清单行）+ ## assistant。 */
export declare function turnBody(turn: TurnContent): string[];
/** 完整轮次文件文本（末尾单个换行）。 */
export declare function renderTurn(turn: TurnContent): string;
/** index frontmatter（字段：title/session/started/model/turns/fork_from）。 */
export declare function indexFrontmatter(meta: SessionMeta): string[];
/** 三列轮次表（`| seq | time | kind |`；契约已无摘要列）。 */
export declare function turnTable(rows: readonly TurnRow[]): string[];
/** 完整 index.md 文本（frontmatter + 轮次表）。 */
export declare function renderIndex(meta: SessionMeta, rows: readonly TurnRow[]): string;
/** 从 index.md 读回元数据（resume 自愈用）；文件不存在或读失败返回 null。 */
export declare function readIndexMeta(indexFile: string): IndexMeta | null;
/** 数 turns/ 下 `NNNN.md` 个数（目录不存在 → 0；读失败 → undefined）。 */
export declare function countTurnFiles(turnsDir: string): number | undefined;
/**
 * 扫 turns/ 读回**磁盘上已存在的序号集合**（SPEC §6 的「磁盘最大序号」来源）。
 *
 * 与 `countTurnFiles` 的区别：这里要的是序号的**具体值**（含洞，例如 `0001,0002,0004`），
 * 不是个数——个数口径正是被跳过的轮次卡死后续记录的原因（见 `src/seq.ts`）。
 *
 * @param turnsDir - `<会话目录>/turns`
 * @returns 序号数组（未排序，可能含重复）；目录不存在 → `[]`；读失败 → `undefined`
 *          （调用方据此区分「空会话」与「读不出来」，后者不许当成空会话重开序号）
 */
export declare function scanTurnSeqs(turnsDir: string): number[] | undefined;
/** 扫 turns/ 读回每轮的 seq/time/kind（按 seq 升序；目录缺失返回空表）。 */
export declare function readTurnRows(dir: string): TurnRow[];
