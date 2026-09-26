// 调查：本机原生 rollout 里，可见消息到底记录成什么？（对比 legacy 事件 vs paginated 的 item_completed）
// 用法：node test/probe-native-shapes.mjs
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
let shown = 0;
for (const f of files) {
  if (shown >= 6) break;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
  if (lines.length === 0) continue;
  const objs = [];
  for (const l of lines) { try { objs.push(JSON.parse(l)); } catch { /* ignore */ } }
  const meta = objs.find((o) => o.type === 'session_meta')?.payload;
  if (!meta || meta.originator === 'dsh-session-handoff') continue;
  shown += 1;

  const hist = new Map();
  for (const o of objs) hist.set(KEY(o), (hist.get(KEY(o)) ?? 0) + 1);
  console.log('='.repeat(72));
  console.log(path.basename(f));
  console.log('  originator:', meta.originator, '| source:', JSON.stringify(meta.source), '| history_mode:', meta.history_mode, '| cli:', meta.cli_version);
  console.log('  行数:', lines.length);
  console.log('  直方图:', JSON.stringify([...hist].sort((a, b) => b[1] - a[1])));

  const firstItemCompleted = objs.find((o) => KEY(o) === 'event_msg/item_completed');
  if (firstItemCompleted) {
    console.log('  item_completed 样例:', JSON.stringify(firstItemCompleted.payload).slice(0, 900));
  }
  const phases = new Set();
  for (const o of objs) {
    if (KEY(o) === 'event_msg/agent_message') phases.add(o.payload.phase);
    if (KEY(o) === 'response_item/message' && o.payload.role === 'assistant') phases.add('resp:' + o.payload.phase);
  }
  console.log('  assistant 的 phase 取值:', JSON.stringify([...phases]));
  const turnStarted = objs.find((o) => KEY(o) === 'event_msg/task_started');
  const turnComplete = objs.find((o) => KEY(o) === 'event_msg/task_complete');
  if (turnStarted) console.log('  task_started 样例:', JSON.stringify(turnStarted.payload).slice(0, 400));
  if (turnComplete) console.log('  task_complete 样例:', JSON.stringify(turnComplete.payload).slice(0, 400));
}
