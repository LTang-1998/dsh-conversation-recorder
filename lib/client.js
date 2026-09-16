window.__ModuleLoader__.load({ id: "dsh-conversation-recorder", factory: (require) => { var __modules = {
"./remote-envelope": function (module, exports, require) {
"use strict";
/**
 * 宿主 Remote 返回**信封**的解包模块。
 *
 * 宿主 settings Remote 的每个方法返回的都是信封，而不是数据本身：
 *   - 成功：`{ ok: true, value }`
 *   - 失败：`{ ok: false, error: { message } }`
 * 官方设置页就是这么解的（`dsh-client-ui-settings/lib/client.js`：
 * `response.ok ? { view: response.value } : { failure: response.error.message }`）。
 *
 * 0.2.1 的客户端半边把返回值**直接当数据用** ⇒ 浏览器里
 * `Cannot read properties of undefined (reading 'find')`，四个值只能显示本地假默认、
 * 保存也显示假成功。本模块就是那条修复：所有 Remote 返回值必须先过这里。
 *
 * 约束（任务书要求）：本文件**不 import react、也不 import 任何宿主包** ——
 * 只有零依赖的纯函数，好让 `tests/run.ts` 直接 import 它做用例。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.unwrapRemoteEnvelope = unwrapRemoteEnvelope;
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** 给报错信息用的形状摘要（避免把整个载荷打进日志）。 */
function shapeOf(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
/**
 * 解包一个宿主 Remote 信封。
 *
 * - `{ ok: true, value }` → 返回 `value`；
 * - `{ ok: false, error: { message } }` → 抛出 `error.message`；
 * - **裸载荷（没有 `ok` 字段）→ 直接抛错**。这一条是关键：0.2.1 就是这么错的，
 *   不许静默把返回值当 `value`（否则坏值会一路装成"读到了"）。
 *
 * @param response 宿主 Remote 的原始返回值
 * @param action   出错的场景名（`读取设置` / `保存设置`），拼进报错信息
 */
function unwrapRemoteEnvelope(response, action) {
    if (!isRecord(response) || typeof response.ok !== 'boolean') {
        throw new Error(`${action}失败：宿主 Remote 没有返回信封（缺 ok 字段，实际 ${shapeOf(response)}）——不许把裸载荷当 value`);
    }
    if (response.ok) {
        return response.value;
    }
    const error = response.error;
    const message = isRecord(error) && typeof error.message === 'string' && error.message !== ''
        ? error.message
        : '宿主未提供错误信息';
    throw new Error(message);
}
/**
 * 读一次设置：解信封 → 在 `namespaces` 里找本命名空间。
 * 读失败（信封 `ok:false` 或裸载荷）由 `unwrapRemoteEnvelope` 抛错，调用方显示在状态行。
 */
async function loadSettings(remote, ns) {
    const described = unwrapRemoteEnvelope(await remote.describe(), '读取设置');
    const descriptor = described.namespaces.find((candidate) => candidate.ns === ns);
    return {
        descriptor,
        value: descriptor === undefined ? {} : descriptor.value,
        ...(descriptor === undefined ? {} : { revision: descriptor.revision }),
    };
}
/**
 * 保存设置：**读真值 → 只发改动过的字段（带真 revision）→ 成功后回读真 revision**。
 *
 * 0.2.x 的写法是本地 `setRevision(previous => (previous ?? 0) + 1)`，即**自己猜**新版本号：
 * 只要宿主端的 revision 不是「+1」这种朴素规则（并发写、别处改过设置、宿主内部每次 mutate
 * 递增的基数不同），猜出来的号就是错的，下一次保存必然 revision conflict。
 *
 * - `ops` 为空 ⇒ 不调 mutate，直接返回 `{ ops: 0, …当前真值 }`（调用方显示「没有变化」）。
 * - mutate 失败（`ok:false`）由 `unwrapRemoteEnvelope` 抛错 ⇒ 调用方显示红色「保存失败：…」，
 *   不再出现「假成功」。
 * - **回读**：mutate 成功后再 describe 一次，把宿主的真 revision 与真值带回去；
 *   绝不本地自增、绝不猜版本号。
 */
async function saveSettings(remote, ns, ops) {
    if (ops.length === 0) {
        const current = await loadSettings(remote, ns);
        return { ops: 0, value: current.value, ...(current.revision === undefined ? {} : { revision: current.revision }) };
    }
    const before = await loadSettings(remote, ns);
    unwrapRemoteEnvelope(await remote.mutate(ns, ops, before.revision), '保存设置');
    // 关键：回读**真** revision（不本地 +1 猜）
    const after = await loadSettings(remote, ns);
    return { ops: ops.length, value: after.value, ...(after.revision === undefined ? {} : { revision: after.revision }) };
}

}
};
var __cache = {};
function __localRequire(spec) {
  if (!Object.prototype.hasOwnProperty.call(__modules, spec)) return require(spec);
  if (__cache[spec]) return __cache[spec].exports;
  var m = { exports: {} };
  __cache[spec] = m;
  __modules[spec](m, m.exports, __localRequire);
  return m.exports;
}
var module = { exports: {} }; var exports = module.exports;
(function (module, exports, require) {
"use strict";
/**
 * dsh-conversation-recorder —— 客户端（浏览器）半边：注册设置页的「会话记录」分区。
 *
 * 契约与宿主侧一致（SPEC §8）：命名空间 `conversation-recorder`，五个字段
 * `enabled` / `root` / `recordSubagents` / `toolArgsPreview` / `emptyIndex`。
 *
 * 观感：与官方「插件」分区同一套行/卡片语言 —— 控件全部来自宿主自带的
 * `@deepseek-ai/dsh-client-ui-primitives`（`Input` / `Button`），颜色、边框、层级全部走 DSH
 * 设计变量（`--dsw-alias-*`）；**没有裸 `<input>` / `<button>` / `<label>`**。
 *
 * 读写都走宿主的 settings Remote（与官方设置页同一条通道）：
 *   - 读：`ctx.remote.settings.describe()` → 找 `ns === 'conversation-recorder'` 的 descriptor
 *     （`value` 是解析后的值、`user` 只含用户覆盖过的字段、`revision` 用于并发保护）；
 *   - 写：`ctx.remote.settings.mutate('conversation-recorder', [{op:'set',path:[字段],value}], revision)`
 *     —— 只改被用户动过的字段，不会删掉它没看见的字段。
 * **两个返回值都是信封**（`{ok:true,value}` / `{ok:false,error}`），一律先过
 * `./remote-envelope.ts` 的 `unwrapRemoteEnvelope()` —— 0.2.1 直接当数据用，才会读不到真值、
 * 保存显示假成功。
 * 读/写失败一律显示在分区里（状态行，不需要开控制台）；客户端半边挂载失败时才只记 console。
 *
 * 构建：本文件由 `build.mjs` 用 `tsc` 编成 CJS 再套浏览器加载握手写成 `lib/client.js`
 * （见 `build-client.mjs`）；类型环境见同目录 `env.d.ts`，独立门禁 `tsconfig.client.json`。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
// 相对模块**不带扩展名**：客户端 bundle 由 `build-client.mjs` 用 `tsc --noResolve` 直出，
// 带 `.ts` 会触发 TS5097（allowImportingTsExtensions 与 emit 互斥）。构建脚本会把同目录的
// 相对模块一起装进 bundle 的本地模块表（见 build-client.mjs）。
const remote_envelope_1 = require("./remote-envelope");
// 读/写两条路径的「解信封 + 保存流程」都在 `remote-envelope.ts`（纯函数、node 侧有用例钉住）。
// 这里显式引用一次，既保留依赖可见性，也防止有人把解包步骤从流程里摘掉：
void remote_envelope_1.unwrapRemoteEnvelope;
/** 设置命名空间（与宿主 `src/settings.ts` 的 SETTINGS_NAMESPACE 一致）。 */
const NS = 'conversation-recorder';
/** 本插件声明的五个设置（默认值与宿主侧一致，仅用于回退显示）。 */
const DEFAULTS = {
    enabled: true,
    root: '',
    recordSubagents: false,
    toolArgsPreview: 40,
    emptyIndex: false,
};
const LABELS = {
    enabled: '启用记录',
    root: '记录根目录',
    recordSubagents: '也记录子代理会话',
    toolArgsPreview: '工具参数预览字数',
    emptyIndex: '元数据事件也建目录并写 index',
};
const DESCRIPTIONS = {
    enabled: 'enabled；关闭后不再产出新文件，已有记录不动。',
    root: '记录根目录（root）；留空则用插件装配配置，再退回内置 <$DSH_HOME>/_conversations。',
    recordSubagents: 'recordSubagents；默认 false，只记顶层会话。',
    toolArgsPreview: 'toolArgsPreview；0–200，默认 40，超出由 schema 拒绝。',
    emptyIndex: 'emptyIndex；默认 false，只有首个内容轮次落盘才建目录。',
};
/* ---- 官方「插件」分区同一套行样式（全部走 DSH 设计变量） ---- */
const sectionStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    maxWidth: 760,
    color: 'var(--dsw-alias-label-primary)',
};
const headingStyle = { margin: 0, fontSize: 18, fontWeight: 600 };
const introStyle = { margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
function fieldStyle(first) {
    return {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 0',
        borderTop: first ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
    };
}
const labelStyle = { fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)' };
const descriptionStyle = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' };
// 说明：**不给官方 `Input` 传 `style`** —— 官方 Input 是「外层 span 负责外观 + 内层 input 负责内容」，
// `style` 会落到内层内容层上（外框里套个小框，两个输入框大小不一致）。外观交回官方控件；
// 满宽由外层 `fieldStyle`（竖向 flex，默认 stretch）自然拉伸。
const footerStyle = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 };
function toForm(value) {
    return {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULTS.enabled,
        root: typeof value.root === 'string' ? value.root : DEFAULTS.root,
        recordSubagents: typeof value.recordSubagents === 'boolean' ? value.recordSubagents : DEFAULTS.recordSubagents,
        toolArgsPreview: typeof value.toolArgsPreview === 'number' ? value.toolArgsPreview : DEFAULTS.toolArgsPreview,
        emptyIndex: typeof value.emptyIndex === 'boolean' ? value.emptyIndex : DEFAULTS.emptyIndex,
    };
}
/** diff 出「用户真的改了」的字段 → mutate 的 path ops（只发变化，不动没看见的字段）。 */
function diffOps(before, after) {
    const ops = [];
    for (const field of Object.keys(DEFAULTS)) {
        if (before[field] !== after[field]) {
            ops.push({ op: 'set', path: [field], value: after[field] });
        }
    }
    return ops;
}
/** 值 → 显示文本（四个值在页面上显示成什么，见交付说明的三步自查清单）。 */
function display(field, form) {
    if (field === 'root')
        return form.root === '' ? '（未设置，用装配配置/内置默认根）' : form.root;
    if (field === 'toolArgsPreview')
        return `${String(form.toolArgsPreview)} 字`;
    return form[field] === true ? '开' : '关';
}
/** 一行设置：标题 + 说明 + 控件（行样式照官方设置分区）。 */
function fieldRow(field, first, control) {
    return (0, react_1.createElement)('div', { key: field, style: fieldStyle(first) }, (0, react_1.createElement)('span', { style: labelStyle }, LABELS[field]), (0, react_1.createElement)('span', { style: descriptionStyle }, DESCRIPTIONS[field]), control);
}
/** 设置分区组件（用 `createElement` 而不是 JSX：本文件是 .ts，构建只过 tsc）。 */
function Section(props) {
    const [form, setForm] = (0, react_1.useState)({ ...DEFAULTS });
    // 说明：revision **不**在组件里持有/自增 —— 每次保存都由 `save-flow.ts` 现读现写并回读真值，
    // 本地猜版本号必然在并发写/别处改过设置时写错（0.2.x 的故障）。
    const [status, setStatus] = (0, react_1.useState)('正在读取当前设置…');
    const [failed, setFailed] = (0, react_1.useState)(false);
    const [loaded, setLoaded] = (0, react_1.useState)(false);
    // 首次挂载读一次真实值（挂载点由 register 的 inject 回调传入的 ctx 提供）
    (0, react_1.useEffect)(() => {
        let alive = true;
        void (async () => {
            try {
                const api = props.ctx;
                if (api === undefined)
                    throw new Error('客户端未注入 ctx');
                // 读真值：解信封 → 找本命名空间（流程在 save-flow.ts，node 侧有用例钉住）
                const loaded = await (0, remote_envelope_1.loadSettings)(api.remote.settings, NS);
                const descriptor = loaded.descriptor;
                if (!alive)
                    return;
                if (descriptor === undefined) {
                    setStatus('宿主未注册本插件的设置命名空间（记录行为不受影响）');
                    setFailed(true);
                    return;
                }
                setForm(toForm(loaded.value));
                setLoaded(true);
                setFailed(false);
                setStatus('');
            }
            catch (error) {
                setFailed(true);
                setStatus(`读取设置失败：${error instanceof Error ? error.message : String(error)}`);
            }
        })();
        return () => {
            alive = false;
        };
    }, [props]);
    const save = async () => {
        setStatus('保存中…');
        setFailed(false);
        try {
            const api = props.ctx;
            if (api === undefined)
                throw new Error('客户端未注入 ctx');
            // 读真值 → 只发改动过的字段（带真 revision）→ 成功后**回读真 revision**（save-flow.ts）
            const loaded = await (0, remote_envelope_1.loadSettings)(api.remote.settings, NS);
            const before = toForm(loaded.value);
            const ops = diffOps(before, form);
            const result = await (0, remote_envelope_1.saveSettings)(api.remote.settings, NS, ops);
            if (result.ops === 0) {
                setStatus('没有变化');
                return;
            }
            // 回读到的真值写回本地状态：显示的是宿主里的真值，下一次保存会现读真 revision
            setForm(toForm(result.value));
            setStatus(`已保存 ${String(result.ops)} 项（即时生效，不用重启）`);
        }
        catch (error) {
            setFailed(true);
            setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const toggle = (field) => () => {
        setForm((previous) => ({ ...previous, [field]: !previous[field] }));
    };
    const rows = [
        (0, react_1.createElement)('h2', { key: 'heading', style: headingStyle }, '会话记录'),
        (0, react_1.createElement)('p', { key: 'intro', style: introStyle }, '把每个会话记录成可读的 Markdown 链（index.md + turns/NNNN.md）。改完即时生效，不用重启。'),
        fieldRow('root', true, (0, react_1.createElement)(dsh_client_ui_primitives_1.Input, {
            value: form.root,
            placeholder: '<$DSH_HOME>/_conversations',
            onChange: (event) => setForm((previous) => ({ ...previous, root: event.target.value })),
        })),
        fieldRow('enabled', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': form.enabled,
            onClick: toggle('enabled'),
        }, display('enabled', form))),
        fieldRow('recordSubagents', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': form.recordSubagents,
            onClick: toggle('recordSubagents'),
        }, display('recordSubagents', form))),
        fieldRow('toolArgsPreview', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Input, {
            type: 'number',
            min: 0,
            max: 200,
            value: form.toolArgsPreview,
            onChange: (event) => setForm((previous) => ({ ...previous, toolArgsPreview: Number(event.target.value) })),
        })),
        fieldRow('emptyIndex', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': form.emptyIndex,
            onClick: toggle('emptyIndex'),
        }, display('emptyIndex', form))),
        (0, react_1.createElement)('div', { key: 'footer', style: footerStyle }, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, { variant: 'primary', size: 'md', disabled: !loaded, onClick: () => void save() }, '保存'), (0, react_1.createElement)('span', { style: failed ? { color: 'var(--dsw-alias-label-error)' } : { color: 'var(--dsw-alias-label-tertiary)' } }, status)),
    ];
    return (0, react_1.createElement)('section', { style: sectionStyle }, ...rows);
}
/** 需要的客户端服务（cordis 客户端 fiber inject）。 */
exports.inject = ['slots', 'remote', 'remote.settings'];
/** 挂载设置分区。整个函数包 try/catch：客户端半边失败不能让 GUI 起不来。 */
function apply(ctx) {
    try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'conversationRecorder',
            order: 55,
            label: () => '会话记录',
            locale: NS,
            // 组件通过 props.ctx 拿到 settings Remote（与官方设置页同一条通道）
            inject: () => ({ ctx }),
        }, Section));
    }
    catch (error) {
        // 设置页是可选 UI：连槽都没挂上时页面上没有可显示的位置，只能记录；
        // 读写失败一律由上面的状态行显示在分区里。
        console.error('dsh-conversation-recorder: settings section mount failed', error);
    }
}

})(module, exports, __localRequire);
return module.exports;
} });
