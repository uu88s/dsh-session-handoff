// 诊断：给定 codex thread id，把「索引库行 → rollout 文件 → 交接记录」三处事实一次打全。
// 用法：node test/diagnose-resume.mjs <threadId> [threadId...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ids = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const dbPath = path.join(codexHome, 'state_5.sqlite');
const WANT = [
  'id', 'rollout_path', 'created_at', 'updated_at', 'source', 'model_provider', 'model',
  'cwd', 'title', 'first_user_message', 'history_mode', 'thread_source', 'originator',
  'cli_version', 'tokens_used', 'has_user_event', 'archived', 'git_sha', 'reasoning_effort',
];

const db = new DatabaseSync(dbPath, { readOnly: true });

for (const id of ids) {
  console.log('='.repeat(72));
  console.log('thread:', id);
  const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  if (!row) {
    console.log('  ✗ threads 表里没有这一行（不是本插件登记的会话）');
  } else {
    for (const k of WANT) if (k in row) console.log(`  ${k}: ${JSON.stringify(row[k])}`);
  }

  const idxPath = path.join(codexHome, 'session_index.jsonl');
  if (fs.existsSync(idxPath)) {
    const hits = fs.readFileSync(idxPath, 'utf8').split('\n').filter((l) => l.includes(id));
    console.log(`  session_index.jsonl 命中: ${hits.length}`, hits[0]?.slice(0, 200) ?? '');
  }

  if (!row?.rollout_path) continue;
  const file = String(row.rollout_path).replace(/^\\\\\?\\/, '');
  if (!fs.existsSync(file)) {
    console.log(`  ✗ rollout 文件不存在: ${file}`);
    continue;
  }
  const st = fs.statSync(file);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  console.log(`  ✓ 文件 ${st.size} 字节 / ${lines.length} 行 / mtime ${st.mtime.toISOString()}`);

  const hist = new Map();
  const roles = new Map();
  let bad = 0;
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { bad += 1; continue; }
    const key = `${o.type}/${o.payload?.type ?? '?'}`;
    hist.set(key, (hist.get(key) ?? 0) + 1);
    if (o.type === 'response_item' && o.payload?.type === 'message') {
      roles.set(o.payload.role, (roles.get(o.payload.role) ?? 0) + 1);
    }
  }
  console.log('  行类型直方图:', JSON.stringify([...hist].sort((a, b) => b[1] - a[1])));
  console.log('  response_item message 角色:', JSON.stringify([...roles]));
  console.log('  无法解析的行:', bad);

  const head = JSON.parse(lines[0]);
  console.log('  首行:', JSON.stringify({
    type: head.type, payloadType: head.payload?.type, id: head.payload?.id,
    session_id: head.payload?.session_id, cwd: head.payload?.cwd,
    originator: head.payload?.originator, cli_version: head.payload?.cli_version,
    source: head.payload?.source, history_mode: head.payload?.history_mode,
  }).slice(0, 400));

  console.log('  头 3 行:');
  for (const l of lines.slice(0, 3)) console.log('   ', l.slice(0, 260));
  console.log('  尾 8 行:');
  for (const l of lines.slice(-8)) {
    const o = JSON.parse(l);
    console.log(`    ordinal=${o.ordinal} ts=${o.timestamp} ${o.type}/${o.payload?.type} ${JSON.stringify(o.payload).slice(0, 220)}`);
  }
}
db.close();

console.log('='.repeat(72));
const logPath = path.join(dshHome, 'session-handoff', 'handoffs.jsonl');
console.log('交接记录:', logPath, fs.existsSync(logPath) ? '存在' : '不存在');
if (fs.existsSync(logPath)) {
  const recs = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log('  共', recs.length, '条，末 8 条：');
  for (const r of recs.slice(-8)) {
    console.log('  ', JSON.stringify({
      kind: r.kind, recordId: r.recordId, sessionId: r.sessionId, threadId: r.threadId,
      rolloutPath: r.rolloutPath, createdAt: r.createdAt, undoOf: r.undoOf,
    }).slice(0, 420));
  }
}
