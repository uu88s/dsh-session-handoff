/**
 * 实验：让 codex 自己把「我们写出的 legacy rollout」迁移成 paginated 格式，
 * 从而得到目标格式的权威模板（事件顺序 + 每种 item 的完整字段）。
 *
 * 用法（需能访问 ~/.codex）：node test/exp-migrate.mjs
 * 会在 ~/.codex 里真实新建一个交接线程，并在最后打印其 id，便于事后撤销。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { planHandoff, executeHandoff } from '../lib/handoff.mjs';
import { resolveCodexHome, stateDatabasePath } from '../lib/codex-store.mjs';

const KEY = (o) => (o.type === 'event_msg' ? `${o.type}/${o.payload?.type ?? '?'}${o.payload?.item ? ':' + o.payload.item.type : ''}` : `${o.type}/${o.payload?.type ?? '?'}`);

function readAll(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const objs = [];
  for (const l of lines) { try { objs.push(JSON.parse(l)); } catch { /* ignore */ } }
  return objs;
}

function histogram(file) {
  const hist = new Map();
  for (const o of readAll(file)) hist.set(KEY(o), (hist.get(KEY(o)) ?? 0) + 1);
  return JSON.stringify([...hist].sort((a, b) => b[1] - a[1]));
}

function codex(args, label) {
  console.log(`\n----- codex ${args.join(' ')}  ${label ? `[${label}]` : ''} -----`);
  const r = spawnSync('codex', args, { stdio: 'inherit', shell: true });
  console.log(`----- 退出码 ${r.status} -----`);
}

const sessionId = process.env.DSH_SESSION_ID;
console.log('源 DSH 会话:', sessionId);
const planned = await planHandoff({ sessionId });
console.log('新线程 id:', planned.threadId);
console.log('rollout:', planned.rolloutPath);
console.log('写入行数:', planned.lines.length);
const written = await executeHandoff(planned);
console.log('executeHandoff ->', JSON.stringify(written));
console.log('\n迁移前直方图:', histogram(planned.rolloutPath));

codex(['migrate-rollouts', '--json', '--thread', planned.threadId], '迁移前：codex 眼中的格式');
codex(['migrate-rollouts', '--apply', '--json', '--thread', planned.threadId], '执行迁移');

const codexHome = resolveCodexHome();
const db = new DatabaseSync(stateDatabasePath(codexHome), { readOnly: true });
const row = db.prepare('SELECT id, rollout_path, history_mode, cli_version, title, tokens_used FROM threads WHERE id = ?').get(planned.threadId);
console.log('\n迁移后 DB 行:', JSON.stringify(row));
db.close();

const finalPath = row?.rollout_path ?? planned.rolloutPath;
console.log('迁移后文件:', finalPath, fs.existsSync(finalPath) ? `${fs.statSync(finalPath).size} 字节` : '（不存在）');
if (fs.existsSync(finalPath)) {
  const objs = readAll(finalPath);
  console.log('迁移后行数:', objs.length);
  console.log('迁移后直方图:', histogram(finalPath));
  console.log('\n事件顺序:');
  for (const o of objs) console.log('  ', KEY(o));
  console.log('\nsession_meta:', JSON.stringify(objs.find((o) => o.type === 'session_meta')?.payload));
  const byItem = new Map();
  for (const o of objs) {
    if (o.payload?.item && !byItem.has(o.payload.item.type)) byItem.set(o.payload.item.type, o);
  }
  for (const [type, sample] of byItem) {
    console.log(`\n模板 item 类型 ${type}:`);
    console.log(JSON.stringify(sample).slice(0, 1200));
  }
}

codex(['migrate-rollouts', '--json', '--thread', planned.threadId], '迁移后：codex 眼中的格式');
console.log('\n（实验线程 id，如需清理：node test/cleanup-thread.mjs ' + planned.threadId + '）');
