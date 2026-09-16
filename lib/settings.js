/**
 * dsh-conversation-recorder —— 宿主侧设置（命名空间 `conversation-recorder`）。
 *
 * 五个字段（契约见 SPEC §8）：
 *   enabled          总开关（默认 true）；关闭＝立即停止产出新文件、已有记录不动
 *   root             记录根目录（默认内置统一位置 `<$DSH_HOME>/_conversations`）
 *   recordSubagents  是否记录子代理会话（默认 false）
 *   toolArgsPreview  工具清单行里参数预览的字数（默认 40，0–200）
 *   emptyIndex       是否允许元数据事件自己建目录并写 index（默认 false）
 *
 * 解析顺序：设置里的值 → 装配配置（`apply(ctx, config)`）→ 内置默认。
 * 设置注册 `applies: 'live'`：改完即时生效，不用重启（引擎每个事件重读，不缓存）。
 *
 * 依赖边界：宿主自带的两个 peer 走**运行时 import**（SPEC §9 白名单，恰好这两个）——
 *   - `@deepseek-ai/schemastery`：schema 必须是**可调用的真 schema**（宿主
 *     `SettingsProvider.register(ns, schema, …)` 会 `schema(base/section)` 求值，见
 *     `@deepseek-ai/dsh-settings/lib/index.js` 的 `resolve()`）；交普通对象会在注册时抛
 *     `TypeError: schema is not a function`。设置页的取值域/控件形状也来自它。
 *   - `@deepseek-ai/dsh-home-paths`：内置默认根用真 `resolveDshHome()` 算，本模块不再保留
 *     一份同语义的本地实现（那是上一轮的偏离，见 CHANGELOG 0.2.1）。
 */
import * as path from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { CONVERSATIONS_DIR } from "./paths.js";
/** 设置命名空间（用户可在 settings.yaml 里写同名段覆盖）。 */
export const SETTINGS_NAMESPACE = 'conversation-recorder';
/** 工具清单行参数预览的默认字数与取值域（SPEC §8）。 */
export const DEFAULT_TOOL_ARGS_PREVIEW = 40;
export const MAX_TOOL_ARGS_PREVIEW = 200;
/** 内置默认根：`<$DSH_HOME>/_conversations`（`$DSH_HOME` 口径来自宿主 `resolveDshHome()`）。 */
export function defaultRoot() {
    // 目录名只有一处真相：`paths.ts` 的 CONVERSATIONS_DIR（这里不再重复一个字面量）
    return path.join(resolveDshHome(), CONVERSATIONS_DIR);
}
/** 五个设置的内置默认值（设置服务缺席时也照这组值工作）。 */
export function defaultSettings() {
    return {
        enabled: true,
        root: defaultRoot(),
        recordSubagents: false,
        toolArgsPreview: DEFAULT_TOOL_ARGS_PREVIEW,
        emptyIndex: false,
    };
}
/**
 * 设置的 schema（真 schemastery：宿主注册时**当函数调用**它求值，设置页用 `toJSON()` 渲染）。
 *
 * 默认值与取值域逐字照 SPEC §8：`enabled` 默认 true、`root` 默认内置统一根、
 * `recordSubagents`/`emptyIndex` 默认 false、`toolArgsPreview` 默认 40 且 0–200（越界由 schema 拒绝）。
 */
export const RecorderSettingsSchema = z.object({
    enabled: z.boolean().default(true).description('启用记录（关闭后不再产出新文件，已有记录不动）'),
    root: z.string().default(defaultRoot()).description('记录根目录（默认 $DSH_HOME/_conversations，支持开头 ~ 展开）'),
    recordSubagents: z.boolean().default(false).description('是否也记录子代理会话'),
    toolArgsPreview: z.natural().min(0).max(MAX_TOOL_ARGS_PREVIEW).default(DEFAULT_TOOL_ARGS_PREVIEW)
        .description(`工具参数预览字数（0–${String(MAX_TOOL_ARGS_PREVIEW)}）`),
    emptyIndex: z.boolean().default(false).description('元数据事件是否也建目录并写 index.md'),
});
/** 把 `unknown`（设置/配置里读出来的）收成五字段；缺失字段用 fallback。 */
function normalize(raw, fallback) {
    if (raw === null || typeof raw !== 'object')
        return fallback;
    const value = raw;
    const enabled = typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled;
    const root = typeof value.root === 'string' ? value.root : fallback.root;
    const recordSubagents = typeof value.recordSubagents === 'boolean' ? value.recordSubagents : fallback.recordSubagents;
    const emptyIndex = typeof value.emptyIndex === 'boolean' ? value.emptyIndex : fallback.emptyIndex;
    const previewRaw = value.toolArgsPreview;
    const toolArgsPreview = typeof previewRaw === 'number' && Number.isFinite(previewRaw)
        ? Math.min(MAX_TOOL_ARGS_PREVIEW, Math.max(0, Math.trunc(previewRaw)))
        : fallback.toolArgsPreview;
    return { enabled, root, recordSubagents, toolArgsPreview, emptyIndex };
}
/** 装配配置 → 设置值（未配置的字段取内置默认）。 */
export function entrySettings(config) {
    return normalize(config, defaultSettings());
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 组装设置来源：注册命名空间（`applies: 'live'`，`base` 层放装配配置）。
 * `provider` 缺席（没挂设置服务）时只用装配配置 + 内置默认，插件照常工作。
 *
 * 注册失败**不再静默**：往 stderr 写一行警告再退回装配配置——上一轮正是那个裸 `catch`
 * 把 `TypeError: schema is not a function` 吞掉，导致命名空间从未注册、设置页读写全废。
 */
export function createSettingsSource(config, provider) {
    const entry = entrySettings(config);
    if (provider === undefined) {
        return { current: () => entry, watch: () => () => { } };
    }
    let scope;
    try {
        scope = provider.register(SETTINGS_NAMESPACE, RecorderSettingsSchema, { applies: 'live', base: entry });
    }
    catch (error) {
        process.stderr.write(`dsh-conversation-recorder: settings register failed for "${SETTINGS_NAMESPACE}": ${errorText(error)}; 退回装配配置\n`);
        return { current: () => entry, watch: () => () => { } };
    }
    return {
        // 宿主 `register` 已按「schema 默认 → 配置 base → 用户段」解析；`scope.get()` 即权威值。
        current: () => normalize(scope.get(), entry),
        watch: (callback) => scope.watch(() => { callback(); }),
    };
}
