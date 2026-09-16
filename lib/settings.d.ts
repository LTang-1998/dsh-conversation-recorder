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
import z from '@deepseek-ai/schemastery';
import type { RecorderConfig } from './paths.js';
/** 设置命名空间（用户可在 settings.yaml 里写同名段覆盖）。 */
export declare const SETTINGS_NAMESPACE = "conversation-recorder";
/** 工具清单行参数预览的默认字数与取值域（SPEC §8）。 */
export declare const DEFAULT_TOOL_ARGS_PREVIEW = 40;
export declare const MAX_TOOL_ARGS_PREVIEW = 200;
/** 内置默认根：`<$DSH_HOME>/_conversations`（`$DSH_HOME` 口径来自宿主 `resolveDshHome()`）。 */
export declare function defaultRoot(): string;
/** 引擎实际读取的五个设置值（都已解析过默认值）。 */
export interface RecorderSettings {
    /** 总开关（默认 true）；false 时引擎不产出任何新文件，已有记录不动。 */
    readonly enabled: boolean;
    /** 设置层给出的 root；空串 = 这一层没有值。 */
    readonly root: string;
    readonly recordSubagents: boolean;
    readonly toolArgsPreview: number;
    readonly emptyIndex: boolean;
}
/** 五个设置的内置默认值（设置服务缺席时也照这组值工作）。 */
export declare function defaultSettings(): RecorderSettings;
/**
 * 设置的 schema（真 schemastery：宿主注册时**当函数调用**它求值，设置页用 `toJSON()` 渲染）。
 *
 * 默认值与取值域逐字照 SPEC §8：`enabled` 默认 true、`root` 默认内置统一根、
 * `recordSubagents`/`emptyIndex` 默认 false、`toolArgsPreview` 默认 40 且 0–200（越界由 schema 拒绝）。
 */
export declare const RecorderSettingsSchema: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    root: z<string, string>;
    recordSubagents: z<boolean, boolean>;
    toolArgsPreview: z<number, number>;
    emptyIndex: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    root: z<string, string>;
    recordSubagents: z<boolean, boolean>;
    toolArgsPreview: z<number, number>;
    emptyIndex: z<boolean, boolean>;
}>>;
/**
 * 设置服务的**最小结构化接口**（不引入 `@deepseek-ai/dsh-settings` 运行时/类型依赖）：
 * 只声明本插件真正用到的 `register`（owner scope）。
 */
export interface SettingsScopeLike {
    get(): unknown;
    watch(callback: (next: unknown, prev: unknown) => void): () => void;
}
export interface SettingsProviderLike {
    register(ns: string, schema: unknown, options: {
        readonly applies: 'live' | 'restart';
        readonly base?: object;
    }): SettingsScopeLike;
}
/** 装配配置（`apply(ctx, config)`）与设置值合并后的权威来源。 */
export interface SettingsSource {
    /** 当前权威设置：设置里的值 → 装配配置 → 内置默认（每次调用重算，改了立刻生效）。 */
    current(): RecorderSettings;
    /** 订阅设置变更（返回取消订阅函数；无设置服务时返回 no-op）。 */
    watch(callback: () => void): () => void;
}
/** 装配配置 → 设置值（未配置的字段取内置默认）。 */
export declare function entrySettings(config: RecorderConfig): RecorderSettings;
/**
 * 组装设置来源：注册命名空间（`applies: 'live'`，`base` 层放装配配置）。
 * `provider` 缺席（没挂设置服务）时只用装配配置 + 内置默认，插件照常工作。
 *
 * 注册失败**不再静默**：往 stderr 写一行警告再退回装配配置——上一轮正是那个裸 `catch`
 * 把 `TypeError: schema is not a function` 吞掉，导致命名空间从未注册、设置页读写全废。
 */
export declare function createSettingsSource(config: RecorderConfig, provider: SettingsProviderLike | undefined): SettingsSource;
