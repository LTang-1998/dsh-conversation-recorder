window.__ModuleLoader__.load({ id: "dsh-conversation-recorder", factory: (require) => { var __modules = {

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
 * 0.2.1 的设置模型：宿主插件 `export const Config`，客户端通过 cordis 服务
 * `ctx.configForms.get(entryId)` 拿到本命名空间的一份表单（`ConfigForm`）：
 *   - 读：`form.getSnapshot()`（`status/value/revision/writable`），`form.subscribe()` 订阅替换；
 *   - 写：`form.set(field, value)`——revision、失败回读、写入排队都由宿主服务负责，
 *     客户端不再自己解信封、也不再自己猜版本号（旧的 settings remote 通道已删）。
 *
 * 命名空间 = profile 里的插件条目 id `dsh-conversation-recorder`（与宿主 `Config` 同名）。
 *
 * 观感：与官方「插件」分区同一套行/卡片语言 —— 控件全部来自宿主自带的
 * `@deepseek-ai/dsh-client-ui-primitives`（`Input` / `Button`），颜色、边框、层级全部走 DSH
 * 设计变量（`--dsw-alias-*`）；**没有裸 `<input>` / `<button>` / `<label>`**。
 *
 * 构建：本文件由 `build-client.mjs` 用 `tsc` 编成 CJS 再套浏览器加载握手写成 `lib/client.js`；
 * 类型环境见同目录 `env.d.ts`，独立门禁 `tsconfig.client.json`。客户端只有这一个本地模块，
 * 相对模块表允许为空。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = void 0;
exports.apply = apply;
const react_1 = require("react");
const dsh_client_ui_primitives_1 = require("@deepseek-ai/dsh-client-ui-primitives");
/** 设置命名空间（与宿主 `src/settings.ts` 的 SETTINGS_NAMESPACE 一致）。 */
const NS = 'dsh-conversation-recorder';
/** 本插件声明的五个设置（默认值仅用于快照到达前的回退显示）。 */
const DEFAULTS = {
    enabled: true,
    root: '',
    recordSubagents: false,
    toolArgsPreview: 40,
    emptyIndex: false,
};
const FIELDS = Object.keys(DEFAULTS);
const LABELS = {
    enabled: '启用记录',
    root: '记录根目录',
    recordSubagents: '也记录子代理会话',
    toolArgsPreview: '工具参数预览字数',
    emptyIndex: '元数据事件也建目录并写 index',
};
const DESCRIPTIONS = {
    enabled: 'enabled；关闭后不再产出新文件，已有记录不动。',
    root: '记录根目录（root）；留空回退内置 <$DSH_HOME>/_conversations。',
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
// 说明：**不给官方 `Input` 传 `style`** —— 外观交回官方控件；满宽由外层 `fieldStyle` 自然拉伸。
const footerStyle = { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 };
function toForm(value) {
    const source = value ?? {};
    return {
        enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled,
        root: typeof source.root === 'string' ? source.root : DEFAULTS.root,
        recordSubagents: typeof source.recordSubagents === 'boolean' ? source.recordSubagents : DEFAULTS.recordSubagents,
        toolArgsPreview: typeof source.toolArgsPreview === 'number' ? source.toolArgsPreview : DEFAULTS.toolArgsPreview,
        emptyIndex: typeof source.emptyIndex === 'boolean' ? source.emptyIndex : DEFAULTS.emptyIndex,
    };
}
/** 值 → 显示文本。 */
function display(field, form) {
    if (field === 'root')
        return form.root === '' ? '（未设置，用内置默认根）' : form.root;
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
    const form = props.form;
    const [formState, setFormState] = (0, react_1.useState)({ ...DEFAULTS });
    const [loadState, setLoadState] = (0, react_1.useState)('loading');
    const [writable, setWritable] = (0, react_1.useState)(false);
    const [notice, setNotice] = (0, react_1.useState)('');
    const [failed, setFailed] = (0, react_1.useState)(false);
    // 挂载即读快照值，并订阅宿主服务推送的替换（写入成功后宿主会推新快照）。
    (0, react_1.useEffect)(() => {
        if (form === undefined) {
            setLoadState('unavailable');
            return;
        }
        const apply = () => {
            const snapshot = form.getSnapshot();
            setLoadState(snapshot.status);
            setWritable(snapshot.writable);
            if (snapshot.status === 'ready')
                setFormState(toForm(snapshot.value));
        };
        apply();
        return form.subscribe(apply);
    }, [form]);
    const save = async () => {
        if (form === undefined)
            return;
        setNotice('保存中…');
        setFailed(false);
        try {
            const base = toForm(form.getSnapshot().value);
            const changed = FIELDS.filter((field) => base[field] !== formState[field]);
            if (changed.length === 0) {
                setNotice('没有变化');
                return;
            }
            const results = [];
            for (const field of changed)
                results.push(await form.set(field, formState[field]));
            if (results.every(Boolean)) {
                setNotice(`已保存 ${String(changed.length)} 项（即时生效，不用重启）`);
            }
            else {
                setFailed(true);
                setNotice('保存被宿主拒绝（可能设置在别处已更新），请重试');
            }
        }
        catch (error) {
            setFailed(true);
            setNotice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const toggle = (field) => () => {
        setFormState((previous) => ({ ...previous, [field]: !previous[field] }));
    };
    const ready = loadState === 'ready';
    const status = loadState === 'unavailable'
        ? '宿主没有暴露本插件的配置（记录行为不受影响）'
        : loadState === 'loading'
            ? '正在读取当前设置…'
            : notice;
    const rows = [
        (0, react_1.createElement)('h2', { key: 'heading', style: headingStyle }, '会话记录'),
        (0, react_1.createElement)('p', { key: 'intro', style: introStyle }, '把每个会话记录成可读的 Markdown 链（index.md + turns/NNNN.md）。改完即时生效，不用重启。'),
        fieldRow('root', true, (0, react_1.createElement)(dsh_client_ui_primitives_1.Input, {
            value: formState.root,
            placeholder: '<$DSH_HOME>/_conversations',
            onChange: (event) => setFormState((previous) => ({ ...previous, root: event.target.value })),
        })),
        fieldRow('enabled', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': formState.enabled,
            onClick: toggle('enabled'),
        }, display('enabled', formState))),
        fieldRow('recordSubagents', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': formState.recordSubagents,
            onClick: toggle('recordSubagents'),
        }, display('recordSubagents', formState))),
        fieldRow('toolArgsPreview', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Input, {
            type: 'number',
            min: 0,
            max: 200,
            value: formState.toolArgsPreview,
            onChange: (event) => setFormState((previous) => ({ ...previous, toolArgsPreview: Number(event.target.value) })),
        })),
        fieldRow('emptyIndex', false, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, {
            variant: 'outline',
            size: 'sm',
            'aria-pressed': formState.emptyIndex,
            onClick: toggle('emptyIndex'),
        }, display('emptyIndex', formState))),
        (0, react_1.createElement)('div', { key: 'footer', style: footerStyle }, (0, react_1.createElement)(dsh_client_ui_primitives_1.Button, { variant: 'primary', size: 'md', disabled: !ready || !writable, onClick: () => void save() }, '保存'), (0, react_1.createElement)('span', { style: failed ? { color: 'var(--dsw-alias-label-error)' } : { color: 'var(--dsw-alias-label-tertiary)' } }, status)),
    ];
    return (0, react_1.createElement)('section', { style: sectionStyle }, ...rows);
}
/** 需要的客户端服务（cordis 客户端 fiber inject）。 */
exports.inject = ['slots', 'configForms'];
/** 挂载设置分区。整个函数包 try/catch：客户端半边失败不能让 GUI 起不来。 */
function apply(ctx) {
    try {
        const form = ctx.configForms.get(NS);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'conversationRecorder',
            order: 55,
            label: () => '会话记录',
            locale: NS,
            // 组件通过 props.form 拿到本命名空间的 ConfigForm（读写都走宿主服务）
            inject: () => ({ form }),
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
