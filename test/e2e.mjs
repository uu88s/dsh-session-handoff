#!/usr/bin/env node
/**
 * 端到端契约测试：客户端半边 → 宿主半边 → 磁盘（真写一次，再撤销）。
 *
 * 不需要浏览器、也不依赖正在运行的 DSH 进程：
 *   - 造一个 `window.__ModuleLoader__` 抓取客户端插件定义；
 *   - 装一个最小 React + 渲染器，把客户端注册的组件真的渲染成标记；
 *   - 把宿主 `apply()` 挂到假 ctx 上，拿到它注册的工具 / 命令 / HTTP 路由；
 *   - 把全局 `fetch` 接到宿主路由上，于是「点点点」走的是真实链路。
 *
 * 会写一次真实的 codex 会话（第 [6] 步），第 [8] 步点「撤销」把它删掉。
 *
 *   node test/e2e.mjs [sessionId]
 */
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { apply as applyHost, HANDOFF_ROUTE } from '../index.js';

let failures = 0;
function check(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  }
  failures += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function step(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ 最小 React */

const hooks = (() => {
  const frames = [];
  return {
    begin() {
      frames.push({ states: [], index: 0, effects: [] });
    },
    end() {
      const frame = frames[frames.length - 1];
      frames.pop();
      return frame.effects;
    },
    useState(initial) {
      const frame = frames[frames.length - 1];
      const index = frame.index++;
      if (!(index in frame.states)) frame.states[index] = typeof initial === 'function' ? initial() : initial;
      return [
        frame.states[index],
        (next) => {
          frame.states[index] = typeof next === 'function' ? next(frame.states[index]) : next;
        },
      ];
    },
    useEffect(effect) {
      frames[frames.length - 1].effects.push(effect);
    },
    useMemo(factory) {
      frames[frames.length - 1].index += 1;
      return factory();
    },
    useRef(value) {
      const frame = frames[frames.length - 1];
      const index = frame.index++;
      if (!(index in frame.states)) frame.states[index] = { current: value };
      return frame.states[index];
    },
  };
})();

const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useState: (initial) => hooks.useState(initial),
  useEffect: (effect) => hooks.useEffect(effect),
  useMemo: (factory) => hooks.useMemo(factory),
  useRef: (value) => hooks.useRef(value),
};

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 渲染成字符串；同时把过程中遇到的宿主元素（button/pre/…）收集起来，方便「点击」。 */
function render(node, out = [], elements = []) {
  if (node === null || node === undefined || node === false || node === true) return { text: out.join(''), elements };
  if (Array.isArray(node)) {
    for (const child of node) render(child, out, elements);
    return { text: out.join(''), elements };
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return { text: out.join(''), elements };
  }
  if (typeof node.type === 'function') {
    hooks.begin();
    const rendered = node.type(node.props);
    const effects = hooks.end();
    render(rendered, out, elements);
    for (const effect of effects) effect();
    return { text: out.join(''), elements };
  }
  const { children, ...rest } = node.props ?? {};
  out.push(`<${String(node.type)}`);
  for (const [key, value] of Object.entries(rest)) {
    if (typeof value === 'function' || value === undefined || value === null || key === 'key') continue;
    out.push(` ${key}="${escapeHtml(String(value))}"`);
  }
  out.push('>');
  elements.push({ type: node.type, props: node.props ?? {} });
  render(children, out, elements);
  out.push(`</${String(node.type)}>`);
  return { text: out.join(''), elements };
}

function textOf(node) {
  return render(node).text;
}

/** 找到按钮（或指定标签的元素）里文字包含 label 的那个，返回它的 props。 */
function findClickable(elements, label) {
  for (const element of elements) {
    if (element.type !== 'button' && element.type !== 'a') continue;
    if (textOf(element.props.children).includes(label)) return element.props;
  }
  return undefined;
}

/** 浮层当前渲染出的**文本**（每次现渲染，读到的是模块内 store 的最新状态）。 */
function toastMarkup() {
  return render(React.createElement(byId('session-handoff-toast'), {})).text;
}

/** 轮询等待某个条件成立（宿主真的读日志、真写盘，耗时不定，不能靠固定 sleep）。 */
async function waitFor(label, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) {
      console.log(`  … 等待超时：${label}`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* ------------------------------------------------------------------ 环境替身 */

const sessionId =
  process.argv[2] ?? process.env.DSH_SESSION_ID ?? 'session-e181bce7-f21a-4a9b-b0a0-aed107f76d87';

let clipboard = null;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    language: 'zh-CN',
    clipboard: { writeText: async (text) => { clipboard = text; } },
  },
  configurable: true,
  writable: true,
});

/* 抓客户端插件定义 */
let definition;
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value; } } };
await import('../client.js');

/* 挂宿主半边 */
const captured = { tool: undefined, command: undefined, route: undefined };
const hostCtx = {
  effect(fn) {
    return fn();
  },
  get() {
    return undefined;
  },
  tools: { register: (value) => { captured.tool = value; return () => {}; } },
  commands: { register: (value) => { captured.command = value; return () => {}; } },
  connection: { fetch: { register: (value) => { captured.route = value; return () => {}; } } },
};
applyHost(hostCtx, {});

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://127.0.0.1:3080');
  const request = new Request(url, init);
  const response = await captured.route.fetch(request);
  const body = await response.clone().json().catch(() => undefined);
  calls.push({ url: url.pathname, request: JSON.parse(init?.body ?? '{}'), status: response.status, body });
  return response;
};

/* ------------------------------------------------------------------ [1] 定义 */

step('[1] 客户端插件定义');
check(definition !== undefined, '调用了 window.__ModuleLoader__.load');
check(definition?.id === '@uu88s/dsh-session-handoff', "id 等于包名", String(definition?.id));
const required = [];
const clientModule = definition.factory((id) => {
  required.push(id);
  if (id === 'react') return React;
  throw new Error(`客户端只允许 require 基线模块，却要了 ${id}`);
});
check(required.join() === 'react', 'factory 只 require 了 react', required.join());
check(
  Array.isArray(clientModule.inject) && clientModule.inject.includes('slots'),
  'inject 声明了 slots',
  JSON.stringify(clientModule.inject),
);
check(typeof clientModule.apply === 'function', 'apply 是函数');

/* ------------------------------------------------------------------ [2] 槽位 */

step('[2] 槽位注册');
const registrations = [];
const injected = [];
clientModule.apply({
  get: () => undefined,
  effect(fn) {
    return fn();
  },
  slots: {
    inject(slot, run) {
      injected.push(slot);
      return run();
    },
    register(entry, Component) {
      registrations.push({ entry, Component });
      return () => {};
    },
  },
});
const expectedSlots = [
  ['sidebar.workspaces.session.row.action', 'session-handoff', 250],
  ['sidebar.workspaces.session.menu.item', 'session-handoff-copy-id', 500],
  ['sidebar.workspaces.session.menu.item', 'session-handoff-to-codex', 600],
  ['conversation.session.header.actions', 'session-handoff', 30],
  ['shell.overlay', 'session-handoff-toast', undefined],
];
check(registrations.length === expectedSlots.length, `注册了 ${expectedSlots.length} 个条目`, `实际 ${registrations.length}`);
for (const [slot, id, order] of expectedSlots) {
  const hit = registrations.find((item) => item.entry.name === slot && item.entry.id === id);
  check(
    hit !== undefined && (order === undefined || hit.entry.order === order),
    `${slot} → ${id}${order === undefined ? '' : ` (order ${order})`}`,
    hit === undefined ? '未注册' : `order=${String(hit.entry.order)}`,
  );
}
const byId = (id) => registrations.find((item) => item.entry.id === id)?.Component;

/* ------------------------------------------------------------------ [3] 静态渲染 */

step('[3] 组件渲染');
const rowMarkup = render(React.createElement(byId('session-handoff'), { sessionId, displayTitle: '演示会话' })).text;
check(rowMarkup.includes('交接给 codex'), '会话行按钮带 aria-label/title', rowMarkup.slice(0, 80));
const copyMarkup = render(
  React.createElement(byId('session-handoff-copy-id'), { sessionId, useMenuOpenState: () => [false, () => {}] }),
).text;
check(copyMarkup.includes('复制 DSH 会话 id'), '菜单项：复制 DSH 会话 id');
const handoffMarkup = render(
  React.createElement(byId('session-handoff-to-codex'), { sessionId, useMenuOpenState: () => [false, () => {}] }),
).text;
check(handoffMarkup.includes('交接给 codex'), '菜单项：交接给 codex');
const headerMarkup = render(React.createElement(byId('session-handoff'), { sessionId })).text;
check(headerMarkup.includes('交接'), '会话头部按钮', headerMarkup.slice(0, 80));
check(render(React.createElement(byId('session-handoff-toast'), {})).text === '', '浮层初始为空');

/* ------------------------------------------------------------------ [4] 复制 id */

step('[4] 点「复制 DSH 会话 id」');
const rowProps = render(React.createElement(byId('session-handoff'), { sessionId })).elements.find(
  (element) => element.type === 'button',
)?.props;
check(typeof rowProps?.onClick === 'function', '拿到了行按钮的 onClick');
const copyProps = findClickable(
  render(
    React.createElement(byId('session-handoff-copy-id'), { sessionId, useMenuOpenState: () => [false, () => {}] }),
  ).elements,
  '复制 DSH 会话 id',
);
check(typeof copyProps?.onClick === 'function', '拿到了菜单项的 onClick');
copyProps.onClick({ stopPropagation() {} });
await new Promise((resolve) => setTimeout(resolve, 30));
check(clipboard === sessionId, '剪贴板收到会话 id', String(clipboard));
const copiedToast = render(React.createElement(byId('session-handoff-toast'), {})).text;
check(copiedToast.includes('已复制会话 id'), '提示条显示已复制', copiedToast.replaceAll('<', '＜').slice(0, 100));

/* ------------------------------------------------------------------ [5] 预演 */

step('[5] 点行按钮 → 预演（真宿主路由）');
render(React.createElement(byId('session-handoff'), { sessionId }))
  .elements.find((element) => element.type === 'button')
  .props.onClick({ stopPropagation() {}, preventDefault() {} });
const planned = await waitFor('宿主返回 plan', () => calls.some((call) => call.request.action === 'plan'));
check(planned, '宿主收到 POST plan');
const planCall = calls.findLast((call) => call.request.action === 'plan');
check(planCall?.status === 200, 'plan 返回 200', String(planCall?.status));
check(planCall?.request.sessionId === sessionId, '请求带了 sessionId');
check(planCall?.body?.described?.threadId !== undefined, '返回了目标线程 id', String(planCall?.body?.described?.threadId));
const planReady = await waitFor('浮层进入确认态', () => toastMarkup().includes('确认交接给 codex？'));
check(planReady, '浮层进入「确认」态');
check(toastMarkup().includes(String(planCall?.body?.described?.threadId)), '浮层显示目标线程 id');
check(toastMarkup().includes('开始写入'), '浮层有「开始写入」');

/* ------------------------------------------------------------------ [6] 写入 */

step('[6] 点「开始写入」→ 真写盘');
const planElements = render(React.createElement(byId('session-handoff-toast'), {})).elements;
const confirmProps = findClickable(planElements, '开始写入');
check(typeof confirmProps?.onClick === 'function', '拿到了「开始写入」的 onClick');
confirmProps.onClick();
const wrote = await waitFor('宿主返回 handoff', () => calls.some((call) => call.request.action === 'handoff'));
check(wrote, '宿主收到 POST handoff');
const handoffCall = calls.findLast((call) => call.request.action === 'handoff');
check(handoffCall?.body?.ok === true, '宿主返回 ok', JSON.stringify(handoffCall?.body?.error ?? ''));
const described = handoffCall?.body?.described;
check(typeof described?.threadId === 'string', '有目标线程 id', String(described?.threadId));
check(existsSync(described?.rolloutPath ?? ''), '目标 rollout 文件已创建', String(described?.rolloutPath));
if (existsSync(described?.rolloutPath ?? '')) {
  check(statSync(described.rolloutPath).size > 1000, '文件非空', `${statSync(described.rolloutPath).size} 字节`);
}
const db = new DatabaseSync(described?.dbPath, { readOnly: true });
const row = db.prepare('SELECT id, source, originator, model_provider FROM threads WHERE id = ?').get(described?.threadId);
db.close();
check(row !== undefined, '索引库已登记该线程', JSON.stringify(row));
const doneReady = await waitFor('浮层进入完成态', () => toastMarkup().includes('codex resume'));
check(doneReady, '浮层给出恢复凭据');
check(toastMarkup().includes(`codex resume ${String(described?.threadId)}`), '恢复凭据内容正确');
check(toastMarkup().includes('撤销这次交接'), '浮层有「撤销」');

/* ------------------------------------------------------------------ [7] 复制恢复命令 */

step('[7] 点「复制恢复命令」');
const doneElements = render(React.createElement(byId('session-handoff-toast'), {})).elements;
const copyCommand = findClickable(doneElements, '复制恢复命令');
check(typeof copyCommand?.onClick === 'function', '拿到了「复制恢复命令」的 onClick');
clipboard = null;
copyCommand.onClick();
const copied = await waitFor('复制反馈', () => toastMarkup().includes('已复制恢复命令'), 15000);
check(clipboard === `codex resume ${String(described?.threadId)}`, '剪贴板收到恢复命令', String(clipboard));
check(copied, '浮层出现已复制反馈');
check(toastMarkup().includes('撤销这次交接'), '复制之后「撤销」按钮仍在（原来会被新提示顶掉）');

/* ------------------------------------------------------------------ [8] 撤销 */

step('[8] 点「撤销这次交接」');
const toastElements = render(React.createElement(byId('session-handoff-toast'), {})).elements;
const undoProps = findClickable(toastElements, '撤销这次交接');
check(typeof undoProps?.onClick === 'function', '拿到了「撤销」的 onClick');
undoProps.onClick();
const undone = await waitFor('宿主返回 undo', () => calls.some((call) => call.request.action === 'undo'));
check(undone, '宿主收到 POST undo');
const undoCall = calls.findLast((call) => call.request.action === 'undo');
check(undoCall?.body?.ok === true, '宿主返回 ok', JSON.stringify(undoCall?.body?.error ?? ''));
check(undoCall?.body?.removedFile === true, '删掉了目标 rollout 文件');
check(undoCall?.body?.removedRows === 1, '删掉了索引行', String(undoCall?.body?.removedRows));
check(!existsSync(described?.rolloutPath ?? ''), '文件确实不存在了', String(described?.rolloutPath));
const db2 = new DatabaseSync(described?.dbPath, { readOnly: true });
const gone = db2.prepare('SELECT id FROM threads WHERE id = ?').get(described?.threadId);
db2.close();
check(gone === undefined, '索引行确实被删了');
const undoneReady = await waitFor('浮层提示已撤销', () => toastMarkup().includes('已撤销'));
check(undoneReady, '浮层提示已撤销');

/* ------------------------------------------------------------------ [9] 错误路径 */

step('[9] 错误路径（宿主返回 409）');
globalThis.fetch = async () =>
  new Response(JSON.stringify({ ok: false, error: '预检失败：找不到 codex 会话库', code: 'PREFLIGHT_FAILED', preflight: { errors: ['找不到 ~/.codex'] } }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  });
const errorElements = render(React.createElement(byId('session-handoff'), { sessionId })).elements;
errorElements.find((element) => element.type === 'button').props.onClick({ stopPropagation() {}, preventDefault() {} });
const errorReady = await waitFor('浮层进入错误态', () => toastMarkup().includes('交接失败'), 15000);
check(errorReady, '浮层进入错误态');
check(toastMarkup().includes('找不到 ~/.codex'), '浮层显示预检细节');
globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ 工具/命令 */

step('[10] 宿主注册的工具与命令');
check(captured.route?.path === HANDOFF_ROUTE, '路由路径', String(captured.route?.path));
check(captured.route?.methods?.includes('POST'), '路由接受 POST', JSON.stringify(captured.route?.methods));
check(captured.tool?.name === 'handoff_session', '工具名', String(captured.tool?.name));
check(captured.tool?.parameters?.properties?.dryRun !== undefined, '工具有 dryRun 参数');
check(Array.isArray(captured.tool?.output?.schema?.required), '工具声明了 output.schema', JSON.stringify(captured.tool?.output?.schema?.required));
check(typeof captured.tool?.output?.render === 'function', '工具声明了 render');
check(captured.command?.name === 'handoff', '命令名', String(captured.command?.name));
const toolResult = await captured.tool.execute({ sessionId, dryRun: true }, {});
check(toolResult.ok === true, '工具 dryRun 执行成功');
check(toolResult.text.includes('交接预演完成'), '工具返回中文摘要', String(toolResult.text).split('\n')[0]);
check(toolResult.threadId === undefined, 'dryRun 不返回可恢复的 threadId');
const commandResult = await captured.command.handler({ rawInput: `${sessionId} --dry-run` });
check(commandResult.kind === 'success', '命令 --dry-run 成功', String(commandResult.text).split('\n')[0]);
// --force 必须被解析并送到撤销路径（用一个不存在的记录 id 探针：应当报「找不到记录」而不是「未知动作」）。
const forceProbe = await captured.command.handler({
  rawInput: '--undo 00000000-0000-4000-8000-000000000000 --force',
});
check(
  forceProbe.kind === 'error' && !String(forceProbe.text).includes('未知动作'),
  '命令 --undo --force 解析到位',
  String(forceProbe.text).split('\n')[0],
);
const listCall = await captured.route.fetch(
  new Request(`http://127.0.0.1:3080${HANDOFF_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'list', sessionId }),
  }),
);
const listBody = await listCall.json();
check(listBody.ok === true && Array.isArray(listBody.handoffs), '路由 list 可用', `${listBody.handoffs?.length ?? 0} 条记录`);

console.log(
  failures === 0
    ? '\n全部通过：客户端 → 宿主 → 磁盘（写入并撤销）链路可用。'
    : `\n${failures} 项失败。`,
);
process.exit(failures === 0 ? 0 : 1);
