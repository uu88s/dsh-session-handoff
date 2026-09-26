// 调查：codex 原生 rollout 里，「用户在 TUI 里说的话」和「助手可见回复」到底写在哪种记录里。
// 这决定了我们转写的文件在 `codex resume` 的界面里能不能显示出历史。
// 用法：node test/probe-rollout-shapes.mjs [--samples]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.homedir(), '.codex', 'sessions');
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(root);
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

const KEY = (o) => `${o.type}/${o.payload?.type ?? '?'}`;
const survey = [];
for (const f of files.slice(0, 60)) {
  const stat = fs.statSync(f);
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { continue; }
  if (lines.length === 0) continue;
  const counts = { user_msg: 0, agent_msg: 0, asst_item: 0, user_item: 0, turn_context: 0 };
  let meta = null;
  let parseErrors = 0;
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { parseErrors += 1; continue; }
    if (!meta && o.type === 'session_meta') meta = o.payload;
    const k = KEY(o);
    if (k === 'event_msg/user_message') counts.user_msg += 1;
    else if (k === 'event_msg/agent_message') counts.agent_msg += 1;
    else if (k === 'response_item/message') {
      if (o.payload.role === 'assistant') counts.asst_item += 1;
      else if (o.payload.role === 'user') counts.user_item += 1;
    } else if (k === 'turn_context/turn_context') counts.turn_context += 1;
  }
  survey.push({
    f, bytes: stat.size, lines: lines.length, mtime: new Date(stat.mtimeMs).toISOString(),
    originator: meta?.originator ?? '?', cli: meta?.cli_version ?? '?',
    source: typeof meta?.source === 'string' ? meta.source : JSON.stringify(meta?.source ?? null).slice(0, 40),
    ...counts, parseErrors,
  });
}

console.log('扫描', files.length, '个 rollout，取最新 60 个（本机 codex 版本:', survey[0]?.cli ?? '?', '）');
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('行数', 7) + pad('user_msg', 9) + pad('agent_msg', 10) + pad('asst_item', 10) + pad('usr_item', 9) + pad('turn_ctx', 9) + pad('originator', 22) + '文件名');
for (const s of survey.slice(0, 30)) {
  console.log(pad(s.lines, 7) + pad(s.user_msg, 9) + pad(s.agent_msg, 10) + pad(s.asst_item, 10) + pad(s.user_item, 9) + pad(s.turn_context, 9) + pad(s.originator, 22) + path.basename(s.f).slice(0, 60));
}

const native = survey.find((s) => s.originator !== 'dsh-session-handoff' && s.user_msg > 0 && s.agent_msg > 0 && s.lines > 20);
console.log('\n原生样本（含 user_message + agent_message）:', native ? path.basename(native.f) : '未找到');
if (native) {
  const lines = fs.readFileSync(native.f, 'utf8').split('\n').filter((l) => l.trim());
  console.log('  该文件行序（type/payload.type，前 60 行）:');
  lines.slice(0, 60).forEach((l, i) => {
    const o = JSON.parse(l);
    console.log(`   ${pad(i, 4)} ${KEY(o)}`);
  });
  const interesting = new Set([
    'event_msg/user_message', 'event_msg/agent_message', 'event_msg/task_started',
    'event_msg/task_complete', 'event_msg/token_count', 'turn_context/turn_context',
    'response_item/message', 'response_item/function_call', 'response_item/reasoning',
  ]);
  const shown = new Set();
  console.log('  每种记录的完整样例（截断 700 字符）:');
  for (const l of lines) {
    const o = JSON.parse(l);
    const k = KEY(o);
    if (!interesting.has(k)) continue;
    const sub = k === 'response_item/message' ? `${k}:${o.payload.role}` : k;
    if (shown.has(sub)) continue;
    shown.add(sub);
    console.log(`   [${sub}] ${l.slice(0, 700)}`);
  }
}

if (process.argv.includes('--samples')) {
  console.log('\n前 5 个文件的 session_meta 摘要:');
  for (const s of survey.slice(0, 5)) {
    const first = JSON.parse(fs.readFileSync(s.f, 'utf8').split('\n')[0]);
    console.log('  ', path.basename(s.f));
    console.log('    ', JSON.stringify({
      originator: first.payload?.originator, source: first.payload?.source,
      thread_source: first.payload?.thread_source, history_mode: first.payload?.history_mode,
      cwd: first.payload?.cwd, id: first.payload?.id,
    }).slice(0, 300));
  }
}
