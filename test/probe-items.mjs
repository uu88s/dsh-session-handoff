// 调查：从本机 paginated 原生 rollout 里抽取各类型 item_completed 的完整载荷，作为转录格式的模板。
// 用法：node test/probe-items.mjs
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

const samples = new Map(); // item.type -> {payload, file}
const turnFlow = [];       // 第一条 paginated 文件的事件顺序
let flowFile = null;
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n').filter((l) => l.trim());
  let objs = [];
  for (const l of lines) { try { objs.push(JSON.parse(l)); } catch { /* ignore */ } }
  const meta = objs.find((o) => o.type === 'session_meta')?.payload;
  if (!meta || meta.originator === 'dsh-session-handoff') continue;
  if (meta.history_mode !== 'paginated') continue;
  if (!flowFile) {
    flowFile = path.basename(f);
    for (const o of objs) {
      const t = o.type === 'event_msg' ? o.payload?.type : o.type;
      turnFlow.push(`${t}${o.payload?.item ? ':' + o.payload.item.type : ''}`);
    }
  }
  for (const o of objs) {
    if (o.type !== 'event_msg' || o.payload?.type !== 'item_completed') continue;
    const it = o.payload.item;
    if (!it || samples.has(it.type)) continue;
    samples.set(it.type, { payload: o.payload, file: path.basename(f) });
  }
}

console.log('线索文件（第一条 paginated）:', flowFile);
console.log('事件顺序:');
console.log('  ' + turnFlow.join('\n  '));
console.log('');
for (const [type, s] of samples) {
  console.log('='.repeat(72));
  console.log('item 类型:', type);
  console.log('文件:', s.file);
  console.log(JSON.stringify(s.payload).slice(0, 1600));
}
