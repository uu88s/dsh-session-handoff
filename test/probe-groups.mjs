// 调查：按 (originator, cli_version) 分组统计本机 rollout 的记录风格，
// 判断“界面通道”到底是 legacy event_msg(user_message/agent_message) 还是 paginated 的 item_completed。
// 用法：node test/probe-groups.mjs
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
console.log('rollout 文件总数:', files.length);

const KEY = (o) => `${o.type}/${o.payload?.type ?? '?'}`;
const interest = new Set([
  'event_msg/item_completed',
  'event_msg/user_message',
  'event_msg/agent_message',
  'event_msg/task_started',
  'event_msg/task_complete',
  'event_msg/turn_aborted',
  'response_item/message',
  'response_item/agent_message',
]);
const groups = new Map();
let scanned = 0;
for (const f of files.slice(0, 600)) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) continue;
  let meta = null;
  const counts = {};
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'session_meta' && !meta) meta = o.payload;
    const k = KEY(o);
    if (interest.has(k)) counts[k] = (counts[k] ?? 0) + 1;
  }
  if (!meta) continue;
  scanned += 1;
  const gk = `${meta.originator ?? '?'} | cli=${meta.cli_version ?? '?'} | mode=${meta.history_mode ?? '?'} | src=${typeof meta.source === 'string' ? meta.source : 'obj'}`;
  if (!groups.has(gk)) groups.set(gk, { files: 0, counts: {}, samples: [] });
  const g = groups.get(gk);
  g.files += 1;
  for (const [k, v] of Object.entries(counts)) g.counts[k] = (g.counts[k] ?? 0) + v;
  if (g.samples.length < 2) g.samples.push(path.basename(f));

  // 顺带找出“paginated 却没有 item_completed”的异常文件
  if (meta.history_mode === 'paginated' && !counts['event_msg/item_completed'] && meta.originator !== 'dsh-session-handoff') {
    console.log('  [注意] paginated 但无 item_completed:', path.basename(f), JSON.stringify(counts));
  }
}
console.log('已扫描:', scanned);
for (const [k, g] of [...groups].sort((a, b) => b[1].files - a[1].files)) {
  console.log('='.repeat(72));
  console.log(k, '| 文件数:', g.files);
  console.log('  计数:', JSON.stringify(g.counts));
  console.log('  样例:', g.samples.join(', '));
}
