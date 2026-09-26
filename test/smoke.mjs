/**
 * 冒烟测试：读本会话日志 → IR → rollout 行 → 登记行 → 只读预检。
 * 全程不写任何东西（planHandoff 只算字节，不落盘）。
 *
 * 用法：node test/smoke.mjs [sessionId]
 */
import { strict as assert } from 'node:assert';
import { readSessionLog, normalizeSessionId } from '../lib/dsh-session.mjs';
import { buildIntermediateRepresentation, truncateByBytes } from '../lib/ir.mjs';
import { buildRolloutLines, serializeRollout } from '../lib/codex-rollout.mjs';
import { REQUIRED_THREAD_COLUMNS, preflight, readCodexDefaults, stateDatabasePath } from '../lib/codex-store.mjs';
import { planHandoff, describePlannedHandoff, HandoffError } from '../lib/handoff.mjs';

const sessionId = normalizeSessionId(
  process.argv[2] ?? process.env.DSH_SESSION_ID ?? 'session-e181bce7-f21a-4a9b-b0a0-aed107f76d87',
);

function ok(label, detail) {
  console.log(`  ✓ ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

console.log(`\n[1] 读会话日志 ${sessionId}`);
const session = await readSessionLog(sessionId);
assert.equal(session.header.type, 'session', '首行必须是 session header');
assert.equal(session.header.id, sessionId);
ok('header', `cwd=${session.header.cwd} version=${session.header.version}`);
ok('多帧 zstd', `frames=${session.frameCount} torn=${session.torn} bytes=${session.bytes}`);
ok('事件行', `${session.events.length} 条`);

console.log('\n[2] 中间表示');
const ir = buildIntermediateRepresentation(session);
ok(
  '统计',
  `事件 ${ir.stats.events} / 用户 ${ir.stats.userMessages} / 助手 ${ir.stats.assistantMessages}` +
    ` / 工具结果 ${ir.stats.toolResults} / 重复结果合并 ${ir.stats.duplicateToolResults}` +
    ` / 截断参数 ${ir.stats.truncatedArguments}` +
    ` / 截断输出 ${ir.stats.truncatedOutputs}`,
);
assert.ok(ir.items.length > 0, 'IR 不能为空');
ok('首个用户消息', JSON.stringify(ir.source.firstUserText ?? '').slice(0, 80));
ok('文件改动清单', ir.fileChanges.slice(0, 3).map((entry) => `${entry.path}(${entry.count})`).join(' ') || '（无）');
ok('截断不切坏 UTF-8', (() => {
  const cut = truncateByBytes('中文'.repeat(100), 10);
  return `${cut.text}…省略 ${cut.omittedBytes} 字节`;
})());

console.log('\n[3] rollout 行');
const threadId = '01a0c48a-8912-7ea3-9729-c7e0171d119f';
const lines = buildRolloutLines(ir, {
  threadId,
  createdAt: Date.UTC(2026, 8, 21, 15, 16, 48),
  cwd: ir.source.cwd,
  modelProvider: 'smoke-provider',
});
assert.equal(lines[0].type, 'session_meta', '第 0 行必须是 session_meta');
assert.equal(lines[0].payload.id, threadId);
assert.equal(lines[0].payload.session_id, threadId);
assert.equal(lines[0].payload.history_mode, 'paginated', 'session_meta 必须自称 paginated（与索引行一致）');
assert.equal(lines[0].payload.base_instructions, null);
assert.deepEqual(
  lines.map((line) => line.ordinal),
  lines.map((_line, index) => index),
  'ordinal 必须从 0 连续递增',
);
for (const line of lines) {
  assert.ok(typeof line.timestamp === 'string' && !Number.isNaN(Date.parse(line.timestamp)), 'timestamp 可解析');
  assert.ok(
    ['session_meta', 'response_item', 'event_msg'].includes(line.type),
    `只允许三种行类型，遇到 ${line.type}`,
  );
  const knownResponse = ['message', 'function_call', 'function_call_output'];
  if (line.type === 'response_item') {
    assert.ok(knownResponse.includes(line.payload.type), `未知 response_item：${line.payload.type}`);
  }
  const knownEvent = ['task_started', 'item_completed', 'task_complete'];
  if (line.type === 'event_msg') {
    assert.ok(knownEvent.includes(line.payload.type), `未知 event_msg：${line.payload.type}`);
  }
}

// 界面转录通道（codex 用它渲染「会话历史」）：没有这一通道，resume 后界面就是空白。
const starts = lines.filter((line) => line.payload.type === 'task_started');
const completes = lines.filter((line) => line.payload.type === 'task_complete');
const items = lines.filter((line) => line.payload.type === 'item_completed');
assert.ok(starts.length > 0, '至少要有一轮 task_started');
assert.equal(starts.length, completes.length, 'task_started 与 task_complete 必须成对');
assert.equal(starts.length, lines.stats.turns);
assert.equal(items.length, lines.stats.visibleItems);
const openTurns = new Set();
for (const line of lines) {
  if (line.payload.type === 'task_started') {
    assert.ok(!openTurns.has(line.payload.turn_id), 'turn_id 不能重复');
    openTurns.add(line.payload.turn_id);
  } else if (line.payload.type === 'item_completed') {
    assert.equal(line.payload.thread_id, threadId, 'item_completed.thread_id 必须是本线程');
    assert.ok(openTurns.has(line.payload.turn_id), `item_completed 的 turn_id 必须属于已开启的轮次`);
    const type = line.payload.item?.type;
    assert.ok(['UserMessage', 'AgentMessage'].includes(type), `未知 TurnItem：${type}`);
    assert.ok(Number.isFinite(line.payload.completed_at_ms), 'completed_at_ms 必须是数字');
    if (type === 'UserMessage') {
      assert.equal(line.payload.item.content[0].type, 'text');
      assert.ok(typeof line.payload.item.content[0].text === 'string');
      assert.ok(typeof line.payload.item.client_id === 'string');
    } else {
      assert.equal(line.payload.item.content[0].type, 'Text', 'AgentMessage 内层类型名必须是大写 Text');
    }
  } else if (line.payload.type === 'task_complete') {
    assert.ok(openTurns.delete(line.payload.turn_id), 'task_complete 必须有对应的 task_started');
  }
}
assert.equal(openTurns.size, 0, '每个轮次都必须被 task_complete 收尾');
// 可见消息数必须与 IR 里的对话消息数一致（首条用户消息之前的助手文本没有所属轮次，不进转录）。
const firstUser = ir.items.findIndex((item) => item.kind === 'user-message');
const expectedVisible = ir.items.filter(
  (item, index) =>
    item.kind === 'user-message' || (item.kind === 'assistant-text' && firstUser >= 0 && index > firstUser),
).length;
assert.equal(items.length, expectedVisible, `可见消息数应与 IR 对话消息数一致（${items.length} vs ${expectedVisible}）`);
assert.equal(
  items.filter((line) => line.payload.item.type === 'UserMessage').length,
  ir.items.filter((item) => item.kind === 'user-message').length,
  '用户消息必须全部进转录',
);
ok('界面转录通道', `${starts.length} 轮 / ${items.length} 条可见消息`);
const calls = lines.filter((line) => line.payload.type === 'function_call');
const outputs = lines.filter((line) => line.payload.type === 'function_call_output');
assert.ok(outputs.length <= calls.length, `输出不能多于调用：${calls.length} vs ${outputs.length}`);
const callIdSet = new Set(calls.map((line) => line.payload.call_id));
for (const output of outputs) {
  assert.ok(callIdSet.has(output.payload.call_id), '每条 function_call_output 都必须有配对的 function_call');
  assert.ok(
    lines.indexOf(output) > lines.findLastIndex((line) => line.payload.type === 'function_call' && line.payload.call_id === output.payload.call_id),
    '输出必须排在配对的调用之后',
  );
}
ok('调用/输出配对', `调用 ${calls.length}、输出 ${outputs.length}、无结果 ${lines.stats.unansweredCalls}、悬空输出 ${lines.stats.orphanResults}`);
for (const call of calls) {
  assert.match(call.payload.call_id, /^call_[0-9A-Za-z]{24}$/, 'call_id 形态必须是 call_<24 位 base62>');
  assert.equal(typeof call.payload.arguments, 'string', 'arguments 必须是 JSON 字符串');
  JSON.parse(call.payload.arguments);
}
for (const output of outputs) {
  assert.deepEqual(output.metadata, { client_authored: false, fallback_token_limit_override: 12000 });
}
let previous = 0;
for (const line of lines) {
  const at = Date.parse(line.timestamp);
  assert.ok(at >= previous, '时间戳必须单调不减');
  previous = at;
}
const text = serializeRollout(lines);
assert.ok(text.endsWith('\n'));
const roundTrip = text.trimEnd().split('\n').map((line) => JSON.parse(line));
assert.equal(roundTrip.length, lines.length);
ok(
  '行数与类型',
  `${lines.length} 行（response_item ${lines.filter((line) => line.type === 'response_item').length}` +
    ` / event_msg ${lines.filter((line) => line.type === 'event_msg').length}）`,
);

console.log('\n[4] 目标库预检（只读）');
const report = preflight({});
assert.equal(report.ok, true, `预检失败：${report.errors.join('；')}`);
ok('codexHome', report.codexHome);
ok('索引库', `${report.dbPath}（migration ${report.migrationVersion}）`);
for (const column of REQUIRED_THREAD_COLUMNS) {
  assert.ok(report.columns.includes(column), `threads 表缺列 ${column}`);
}
ok('threads 必需列', `${REQUIRED_THREAD_COLUMNS.length} 列齐全，共 ${report.columns.length} 列`);
ok('state 库发现', String(stateDatabasePath(report.codexHome)));
ok('codex 自身配置', JSON.stringify(readCodexDefaults(report.codexHome)));

console.log('\n[5] 预演（不写盘）');
const planned = await planHandoff({ sessionId, session });
const described = describePlannedHandoff(planned);
ok('目标线程', described.threadId);
ok('rollout 路径', described.rolloutPath);
ok('字节数', `${described.bytes} bytes / ${described.lineCount} 行`);
ok('恢复命令', described.resumeCommand);
ok('将写入的文件', described.files.join(' | '));
ok('索引行', described.rows.join(' | '));
ok('登记用的 provider/model', `${planned.row.model_provider} / ${planned.row.model ?? '（未设）'}`);
ok('cwd（目标）', planned.row.cwd);
for (const warning of described.warnings) console.log(`  ⚠ ${warning}`);

console.log('\n全部通过。没有写入任何文件。\n');
void HandoffError;
