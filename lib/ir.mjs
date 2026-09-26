/**
 * DSH 事件流 → 中间表示（IR）。
 *
 * 保真度（ADR-0001 / Q8）：对话文本 + 工具调用（参数截断 2KB）+ 工具输出（每条截断 8KB，
 * 截断时标注来源 DSH 会话 id）+ 文件改动摘要。不含附件、不含系统提示快照。
 *
 * 只消费「对话」事件：`user/message`（仅 source.kind==='user'）、`assistant/message`
 * 的 text 块、`tool/call`、`tool/result`。reasoning 块、agent-instructions、
 * runtime-context 一律不进 IR，只计数（它们是 harness 自己的上下文，不是对话内容）。
 */

const DEFAULT_ARG_LIMIT = 2048;
const DEFAULT_OUTPUT_LIMIT = 8192;

/** 把 DSH 内容块数组压成纯文本。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片附件：未转写（v1 不含附件）]');
  }
  return parts.join('\n');
}

/**
 * 按 UTF-8 字节数截断，保证不切坏多字节字符。
 * @returns {{text: string, truncated: boolean, omittedBytes: number}}
 */
export function truncateByBytes(text, maxBytes, label) {
  const value = typeof text === 'string' ? text : '';
  const size = Buffer.byteLength(value, 'utf8');
  if (size <= maxBytes) return { text: value, truncated: false, omittedBytes: 0 };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const head = value.slice(0, low);
  return { text: head, truncated: true, omittedBytes: size - Buffer.byteLength(head, 'utf8'), label };
}

/** 从图省事的参数 JSON 里挑出涉及的文件路径，供「文件改动摘要」用。 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'notebook_path', 'filename'];

function collectPaths(value, into, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) collectPaths(entry, into, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_KEYS.includes(key) && typeof entry === 'string' && entry.length > 0) into.add(entry);
    else collectPaths(entry, into, depth + 1);
  }
}

/** 汇总工具调用里出现的文件路径（Q8:d 的「文件改动摘要」）。 */
export function summarizeFileChanges(items) {
  const counts = new Map();
  for (const item of items) {
    if (item.kind !== 'tool-call') continue;
    let parsed;
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    const paths = new Set();
    collectPaths(parsed, paths);
    for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, count]) => ({ path, count }));
}

/**
 * 构建 IR。
 * @param {{header: object, events: object[], logPath: string}} session
 * @param {{toolArgumentsMaxBytes?: number, toolOutputMaxBytes?: number, now?: number}} [options]
 */
export function buildIntermediateRepresentation(session, options = {}) {
  const argLimit = options.toolArgumentsMaxBytes ?? DEFAULT_ARG_LIMIT;
  const outputLimit = options.toolOutputMaxBytes ?? DEFAULT_OUTPUT_LIMIT;
  const header = session.header ?? {};
  const sessionId = String(header.id ?? '');
  const items = [];
  const stats = {
    events: session.events.length,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    truncatedArguments: 0,
    truncatedOutputs: 0,
    skippedReasoningBlocks: 0,
    skippedContextMessages: 0,
    duplicateToolResults: 0,
    skippedEvents: {},
  };
  // 同一个 callId 在 DSH 日志里可能留两条结果（一条全量、一条截断副本）：合并成一条，留更长的那条。
  const resultIndex = new Map();
  let title;
  let createdAt = header.createdAt;
  let model;
  let provider;
  let reasoningEffort;
  let sandboxMode;
  let approvalPolicy;
  let firstUserText;

  for (const event of session.events) {
    const type = event?.type;
    const data = event?.data ?? {};
    const time = typeof event?.time === 'number' ? event.time : undefined;
    switch (type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.length > 0) title = data.title;
        break;
      }
      case 'model/selection': {
        if (typeof data.model === 'string') model = data.model;
        if (typeof data.provider === 'string') provider = data.provider;
        if (typeof data.reasoningEffort === 'string') reasoningEffort = data.reasoningEffort;
        break;
      }
      case 'sandbox/mode': {
        if (typeof data.mode === 'string') sandboxMode = data.mode;
        break;
      }
      case 'approval/policy': {
        if (typeof data.policy === 'string') approvalPolicy = data.policy;
        break;
      }
      case 'user/message': {
        const kind = data?.source?.kind ?? 'user';
        const text = textOfContent(data?.content);
        if (kind !== 'user') {
          stats.skippedContextMessages += 1;
          break;
        }
        if (text.trim().length === 0) break;
        firstUserText ??= text;
        stats.userMessages += 1;
        items.push({ kind: 'user-message', text, time, role: 'user' });
        break;
      }
      case 'assistant/message': {
        let emitted = false;
        for (const block of data?.message?.content ?? []) {
          if (block?.type === 'reasoning') {
            stats.skippedReasoningBlocks += 1;
            continue;
          }
          if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
            stats.assistantMessages += 1;
            items.push({ kind: 'assistant-text', text: block.text, time, role: 'assistant' });
            emitted = true;
          }
        }
        if (!emitted) stats.skippedEvents['assistant/message(no-text)'] =
          (stats.skippedEvents['assistant/message(no-text)'] ?? 0) + 1;
        break;
      }
      case 'tool/call': {
        const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {});
        const cut = truncateByBytes(raw, argLimit, 'arguments');
        if (cut.truncated) stats.truncatedArguments += 1;
        stats.toolCalls += 1;
        items.push({
          kind: 'tool-call',
          callId: String(data.callId ?? ''),
          name: String(data.name ?? 'unknown'),
          arguments: cut.text,
          argumentsTruncated: cut.truncated,
          omittedBytes: cut.omittedBytes,
          time,
        });
        break;
      }
      case 'tool/result': {
        const message = data?.message ?? {};
        const content = textOfContent(message?.content);
        const cut = truncateByBytes(content, outputLimit, 'output');
        if (cut.truncated) stats.truncatedOutputs += 1;
        const callId = String(message?.toolCallId ?? message?.source?.callId ?? '');
        const suffix = cut.truncated
          ? `\n…[输出被截断，省略 ${cut.omittedBytes} 字节；完整内容见 DSH 会话 ${sessionId}]`
          : '';
        const bytes = Buffer.byteLength(cut.text, 'utf8');
        const existing = resultIndex.get(callId);
        if (existing !== undefined) {
          stats.duplicateToolResults += 1;
          const previous = items[existing];
          if (bytes > previous.bytes) {
            items[existing] = {
              ...previous,
              text: cut.text + suffix,
              bytes,
              isError: message?.isError === true,
              duplicates: (previous.duplicates ?? 1) + 1,
            };
          }
          break;
        }
        stats.toolResults += 1;
        resultIndex.set(callId, items.length);
        items.push({
          kind: 'tool-result',
          callId,
          text: cut.text + suffix,
          bytes,
          isError: message?.isError === true,
          time,
        });
        break;
      }
      default: {
        if (typeof type === 'string') {
          stats.skippedEvents[type] = (stats.skippedEvents[type] ?? 0) + 1;
        }
      }
    }
  }

  const fileChanges = summarizeFileChanges(items);
  return {
    source: {
      sessionId,
      cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
      title,
      createdAt,
      model,
      provider,
      reasoningEffort,
      sandboxMode,
      approvalPolicy,
      firstUserText,
      logPath: session.logPath,
    },
    items,
    stats,
    fileChanges,
  };
}
