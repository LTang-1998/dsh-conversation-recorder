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
import z from '@deepseek-ai/schemastery';
/** 设置命名空间（= profile 里的插件条目 id，0.2.1 的 configForms 也按它取值）。 */
export declare const SETTINGS_NAMESPACE = "dsh-conversation-recorder";
/** 工具清单行参数预览的默认字数与取值域（SPEC §8）。 */
export declare const DEFAULT_TOOL_ARGS_PREVIEW = 40;
export declare const MAX_TOOL_ARGS_PREVIEW = 200;
/** 内置默认根：`<$DSH_HOME>/_conversations`（`$DSH_HOME` 口径来自宿主 `resolveDshHome()`）。 */
export declare function defaultRoot(): string;
/** 一个 `.volatile()` 配置字段：`get()` 永远返回当前值（设置页改了立刻可见）。 */
export interface ConfigValue<T> {
    get(): T;
}
/** apply() 收到的 Config 实例（五个字段都是稳定引用，见 `Config`）。 */
export interface RecorderConfig {
    readonly enabled: ConfigValue<boolean>;
    readonly root: ConfigValue<string>;
    readonly recordSubagents: ConfigValue<boolean>;
    readonly toolArgsPreview: ConfigValue<number>;
    readonly emptyIndex: ConfigValue<boolean>;
}
/**
 * 插件配置 schema（宿主读取的 `Config` 导出）。
 *
 * 五个字段都 `.volatile()`：宿主把它们暴露成 `config.<field>.get()` 的稳定引用，
 * 设置页写入后下一次 `get()` 立刻拿到新值（不用重启、也不用重新加载插件）。
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    root: z<string, string, "volatile-defined">;
    recordSubagents: z<boolean, boolean, "volatile-defined">;
    toolArgsPreview: z<number, number, "volatile-defined">;
    emptyIndex: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "volatile-defined">;
    root: z<string, string, "volatile-defined">;
    recordSubagents: z<boolean, boolean, "volatile-defined">;
    toolArgsPreview: z<number, number, "volatile-defined">;
    emptyIndex: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
/** 引擎实际使用的五个设置值（从 Config 的 getter 读出的快照）。 */
export interface RecorderSettings {
    /** 总开关（默认 true）；false 时引擎不产出任何新文件，已有记录不动。 */
    readonly enabled: boolean;
    /** 记录根；空串 = 这一层没有值（退回内置默认根）。 */
    readonly root: string;
    readonly recordSubagents: boolean;
    readonly toolArgsPreview: number;
    readonly emptyIndex: boolean;
}
/**
 * 把 Config 的五个 getter 收成一份普通快照（每个事件重读，不缓存）。
 *
 * 取值域兜底与 schema 一致：`toolArgsPreview` 越界钳到 0–200（防御旧配置文件/手写
 * patch 绕过 schema 的情况），其余字段只认各自类型，异常值退回内置默认。
 */
export declare function settingsOf(config: RecorderConfig): RecorderSettings;
