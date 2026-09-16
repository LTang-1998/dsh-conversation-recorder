/**
 * 客户端半边的**类型环境**（`tsconfig.client.json` 与 `build-client.mjs` 共用）。
 *
 * 客户端代码在浏览器里跑，`react` 与 `@deepseek-ai/dsh-client-ui-primitives` 都由 shell 的
 * 基线模块表提供（运行时是真实现，产物里只留 `require(...)` 外部引用）；本仓库不安装它们的
 * 类型包，故这里只声明本插件真正用到的 API —— 与官方设置分区用同一套控件原子。
 */

declare module 'react' {
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 官方按钮原子（variant: primary/ghost/outline/toolbar，size: md/sm）。 */
  export function Button(props: Record<string, unknown>): unknown
  /** 官方单行输入原子。 */
  export function Input(props: Record<string, unknown>): unknown
}
