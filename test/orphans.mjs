/**
 * 诊断：同一 callId 是否出现多条 tool/result（live 会话里常见），
 * 以及 IR 计数与原始事件计数是否一致。只读。
 */
import { readSessionLog, normalizeSessionId } from '../lib/dsh-session.mjs';
import { buildIntermediateRepresentation } from '../lib/ir.mjs';

const sessionId = normalizeSessionId(process.argv[2] ?? process.env.DSH_SESSION_ID ?? '');
const session = await readSessionLog(sessionId);

const key = (message) => String(message?.toolCallId ?? message?.source?.callId ?? '');
const callEvents = session.events.filter((event) => event.type === 'tool/call');
const resultEvents = session.events.filter((event) => event.type === 'tool/result');
const ir = buildIntermediateRepresentation(session);

console.log(`原始：tool/call ${callEvents.length} 条，tool/result ${resultEvents.length} 条`);
console.log(
  `IR  ：toolCalls ${ir.stats.toolCalls}，toolResults ${ir.stats.toolResults}` +
    `（对话项 ${ir.items.length}：${Object.entries(
      ir.items.reduce((into, item) => ({ ...into, [item.kind]: (into[item.kind] ?? 0) + 1 }), {}),
    )
      .map(([kind, count]) => `${kind}=${count}`)
      .join(' ')}）`,
);

const perCall = new Map();
for (const event of resultEvents) {
  const id = key(event.data?.message);
  perCall.set(id, (perCall.get(id) ?? 0) + 1);
}
const duplicates = [...perCall.entries()].filter(([, count]) => count > 1);
console.log(`\n一个 callId 对应多条结果的：${duplicates.length} 个`);
for (const [id, count] of duplicates.slice(0, 10)) {
  console.log(`  ${id} × ${count}`);
  const events = resultEvents.filter((event) => key(event.data?.message) === id);
  events.forEach((event, index) => {
    const text = (event.data?.message?.content ?? [])
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n');
    console.log(`    [${index}] isError=${String(event.data?.message?.isError === true)} bytes=${Buffer.byteLength(text, 'utf8')} head=${JSON.stringify(text.slice(0, 120))}`);
  });
}

const callIds = new Set(callEvents.map((event) => String(event.data?.callId ?? '')));
const resultIds = new Set(perCall.keys());
const orphanIds = [...resultIds].filter((id) => !callIds.has(id));
console.log(`\n结果里有、调用里没有的 callId：${orphanIds.length} 个 ${JSON.stringify(orphanIds.slice(0, 5))}`);
const unanswered = [...callIds].filter((id) => !resultIds.has(id));
console.log(`调用里有、结果里没有的 callId：${unanswered.length} 个`);

// 重复的 pair：把 IR 里同 callId 的调用与结果数量也打出来。
const irCalls = ir.items.filter((item) => item.kind === 'tool-call').map((item) => item.callId);
const irResults = ir.items.filter((item) => item.kind === 'tool-result').map((item) => item.callId);
const irCallCount = new Map();
const irResultCount = new Map();
for (const id of irCalls) irCallCount.set(id, (irCallCount.get(id) ?? 0) + 1);
for (const id of irResults) irResultCount.set(id, (irResultCount.get(id) ?? 0) + 1);
const ambiguous = [...irResultCount.entries()].filter(([, count]) => count > 1);
console.log(`\nIR 里结果多于一条的 callId：${ambiguous.length} 个`);
for (const [id, count] of ambiguous.slice(0, 10)) {
  console.log(`  ${id} → 调用 ${irCallCount.get(id) ?? 0} 条 / 结果 ${count} 条`);
}
const missingCall = [...irResultCount.keys()].filter((id) => !irCallCount.has(id));
console.log(`IR 里只有结果没有调用的 callId：${missingCall.length} 个 ${JSON.stringify(missingCall.slice(0, 5))}`);
