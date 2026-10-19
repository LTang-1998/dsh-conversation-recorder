/**
 * dsh-conversation-recorder —— 宿主侧配置（0.2.1 的 Config 模型）。
 *
 * 命名空间就是 profile 里的插件条目 id `dsh-conversation-recorder`；五个字段
 * （契约见 SPEC §8）全部 `.volatile()`：
 *   enabled          总开关（默认 true）；关闭＝立即停止产出新文件、已有记录不动
 *   root             记录根目录（默认内置统一位置 `<$DSH_HOME>/_conversations`）
 *   recordSubagents  是否记录子代理会话（默认 false）
 *   toolArgsPreview  工具清单行里参数预览的字数（默认 40，0–200）
 *   emptyIndex       是否允许元数据事件自己建目录并写 index（默认 false）
 *
 * 0.2.1 起宿主不再有旧的设置注册 API：插件自己 `export const Config`，宿主按
 * schema 渲染/校验，`.volatile()` 让五个字段变成**稳定引用**（每次读都拿到当前值，
 * `config.<field>.get()`），设置页与 cordis.patch.yml 写的是同一份值。
 *
 * 依赖边界：两个宿主自带的包走**运行时 import**（SPEC §9 白名单，恰好这两个）——
 *   - `@deepseek-ai/schemastery`：`Config` 必须是真 schema；
 *   - `@deepseek-ai/dsh-home-paths`：内置默认根用真 `resolveDshHome()` 算。
 */
import * as path from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { CONVERSATIONS_DIR } from "./paths.js";
/** 设置命名空间（= profile 里的插件条目 id，0.2.1 的 configForms 也按它取值）。 */
export const SETTINGS_NAMESPACE = 'dsh-conversation-recorder';
/** 工具清单行参数预览的默认字数与取值域（SPEC §8）。 */
export const DEFAULT_TOOL_ARGS_PREVIEW = 40;
export const MAX_TOOL_ARGS_PREVIEW = 200;
/** 内置默认根：`<$DSH_HOME>/_conversations`（`$DSH_HOME` 口径来自宿主 `resolveDshHome()`）。 */
export function defaultRoot() {
    // 目录名只有一处真相：`paths.ts` 的 CONVERSATIONS_DIR（这里不再重复一个字面量）
    return path.join(resolveDshHome(), CONVERSATIONS_DIR);
}
/**
 * 插件配置 schema（宿主读取的 `Config` 导出）。
 *
 * 五个字段都 `.volatile()`：宿主把它们暴露成 `config.<field>.get()` 的稳定引用，
 * 设置页写入后下一次 `get()` 立刻拿到新值（不用重启、也不用重新加载插件）。
 */
export const Config = z.object({
    enabled: z.boolean().default(true).volatile()
        .description('启用记录（关闭后不再产出新文件，已有记录不动）'),
    root: z.string().default(defaultRoot()).volatile()
        .description('记录根目录（默认 $DSH_HOME/_conversations，支持开头 ~ 展开）'),
    recordSubagents: z.boolean().default(false).volatile()
        .description('是否也记录子代理会话'),
    toolArgsPreview: z.natural().min(0).max(MAX_TOOL_ARGS_PREVIEW).default(DEFAULT_TOOL_ARGS_PREVIEW).volatile()
        .description(`工具参数预览字数（0–${String(MAX_TOOL_ARGS_PREVIEW)}）`),
    emptyIndex: z.boolean().default(false).volatile()
        .description('元数据事件是否也建目录并写 index.md'),
});
/**
 * 把 Config 的五个 getter 收成一份普通快照（每个事件重读，不缓存）。
 *
 * 取值域兜底与 schema 一致：`toolArgsPreview` 越界钳到 0–200（防御旧配置文件/手写
 * patch 绕过 schema 的情况），其余字段只认各自类型，异常值退回内置默认。
 */
export function settingsOf(config) {
    const rawPreview = Number(config.toolArgsPreview.get());
    const toolArgsPreview = Number.isFinite(rawPreview)
        ? Math.min(MAX_TOOL_ARGS_PREVIEW, Math.max(0, Math.trunc(rawPreview)))
        : DEFAULT_TOOL_ARGS_PREVIEW;
    return {
        enabled: config.enabled.get() === true,
        root: typeof config.root.get() === 'string' ? config.root.get() : '',
        recordSubagents: config.recordSubagents.get() === true,
        toolArgsPreview,
        emptyIndex: config.emptyIndex.get() === true,
    };
}
