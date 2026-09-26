#!/usr/bin/env node
/**
 * 端到端验收：真的往目标 agent（codex）的会话库里写一次交接，然后**独立地**校验结果。
 *
 * 这个脚本会写盘（目标 rollout 文件 + 目标索引库一行），所以每次运行都会打印撤销命令。
 *
 *   node test/acceptance.mjs           真写一次，并打印 `codex resume …`
 *   node test/acceptance.mjs --dry     只预演，不写任何东西
 *   node test/acceptance.mjs --undo    撤销最近一次交接（删掉刚建的目标会话）
 *
 * 任一步失败即退出码非 0。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';

import { handoffToCodex, undoHandoff, listHandoffs } from '../lib/handoff.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const undo = args.includes('--undo');
const sessionId =
  args.find((arg) => !arg.startsWith('--')) ?? process.env.DSH_SESSION_ID ?? undefined;

const sessionArg = sessionId ? { sessionId } : {};

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(label, detail = '') {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
}

if (undo) {
  const result = await undoHandoff({ ...sessionArg, force: args.includes('--force') });
  console.log(`已撤销：${result.threadId ?? '（无记录）'}`);
  console.log(`  源会话：${result.sessionId ?? '（未知）'}`);
  console.log(`  删除文件：${result.removedFile ? '是' : '否'}（${result.rolloutPath}）`);
  console.log(`  删除索引行：${result.removedRows} 行`);
  process.exit(0);
}

console.log(`[1] ${dry ? '预演交接（不写盘）' : '执行交接（会写盘）'}`);
const result = await handoffToCodex({ ...sessionArg, dryRun: dry });
const described = result.described;
const threadId = described.threadId;

console.log(`  源会话：${described.sessionId}`);
console.log(`  源标题：${described.sourceTitle ?? '（无）'}`);
console.log(`  源目录：${described.cwd ?? '（无）'}`);
console.log(`  目标线程：${threadId}`);
console.log(`  目标文件：${described.rolloutPath}`);
console.log(`  索引行：${described.rows.join('；')}`);
console.log(`  行数/字节：${described.lineCount} / ${described.bytes}`);
for (const warning of described.warnings ?? []) console.log(`  ⚠ ${warning}`);
if (dry) {
  console.log('  （--dry：没有写入任何文件）');
  process.exit(0);
}

console.log('\n[2] 独立校验（新开连接、重新读盘）');
const rolloutPath = described.rolloutPath;
const stat = statSync(rolloutPath);
ok('目标文件存在', `${stat.size} 字节`);

const firstLine = readFileSync(rolloutPath, 'utf8').split('\n')[0];
const meta = JSON.parse(firstLine);
assert(meta.type === 'session_meta', `首行必须是 session_meta，实际是 ${meta.type}`);
assert(
  meta.payload?.id === threadId,
  `首行 session_meta.id 必须等于线程 id：${meta.payload?.id} ≠ ${threadId}`,
);
ok('首行 session_meta', `id=${meta.payload.id}`);
ok('目标 cwd', String(meta.payload.cwd));
assert(
  meta.payload.history_mode === 'paginated',
  `session_meta.history_mode 必须是 paginated（与索引行一致），实际 ${meta.payload.history_mode}`,
);

// 界面转录通道：codex 的「会话历史」只从 event_msg 投影，缺了它 resume 后界面就是空白。
const allLines = readFileSync(rolloutPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const evt = (type) => allLines.filter((line) => line.payload?.type === type);
const started = evt('task_started');
const completed = evt('task_complete');
const items = evt('item_completed');
assert(started.length > 0, '必须写出 task_started（否则界面无轮次）');
assert(started.length === completed.length, `task_started/task_complete 必须成对：${started.length} vs ${completed.length}`);
assert(items.length > 0, '必须写出 item_completed（否则界面无消息）');
for (const line of items) {
  assert(line.payload.thread_id === threadId, 'item_completed.thread_id 必须是本线程');
  assert(
    ['UserMessage', 'AgentMessage'].includes(line.payload.item?.type),
    `未知 TurnItem：${line.payload.item?.type}`,
  );
}
ok('界面转录通道', `${started.length} 轮 / ${items.length} 条可见消息`);

const db = new DatabaseSync(described.dbPath, { readOnly: true });
const row = db
  .prepare('SELECT id, rollout_path, cwd, source, originator, model_provider, title, history_mode FROM threads WHERE id = ?')
  .get(threadId);
db.close();
assert(row, '索引库里必须能查到这一行');
assert(row.rollout_path === rolloutPath, `rollout_path 必须与文件一致：${row.rollout_path}`);
ok('索引行已登记', `id=${row.id}`);
ok('登记字段', `source=${row.source} originator=${row.originator} provider=${row.model_provider}`);
ok('历史模式', `history_mode=${row.history_mode}`);

console.log('\n[3] 下一步（在你自己终端里跑）');
console.log(`  codex resume ${threadId}`);
console.log('  非交互式验证：');
console.log(
  `  codex exec resume ${threadId} --json -c sandbox_mode="read-only" -c approval_policy="never" "不要执行任何命令，只回复：已恢复"`,
);
console.log('  界面历史（codex app-server 的转录视图，能看到轮次才算真的能看到历史）：');
console.log(`  node test/probe-transcript.mjs ${threadId}`);
console.log('\n[4] 不想要了就撤销');
console.log('  node test/acceptance.mjs --undo');

const records = await listHandoffs({ sessionId: described.sessionId });
console.log(`\n交接记录：${records.length} 条（$DSH_HOME/session-handoff/handoffs.jsonl）`);
console.log(`恢复凭据：${described.resumeCommand}`);
