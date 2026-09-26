/**
 * IR → codex rollout 行。
 *
 * 写 codex 自己的三种行（其余一律不猜）：
 *   - `session_meta`（第 0 行，必须是它，否则 codex 报
 *     `rollout at .. does not start with session metadata.`）
 *   - `response_item`（message / function_call / function_call_output）= **模型上下文通道**
 *   - `event_msg`（task_started / item_completed / task_complete）= **界面转录通道**
 *
 * 为什么必须有 `event_msg`：codex 的「会话历史」（TUI、桌面端、`codex resume` 后
 * 显示的那串消息）不是从 `response_item` 渲染的，而是由 `EventMsg` 投影而来——
 * paginated 模式看 `item_completed(TurnItem)`，legacy 模式看 `user_message` /
 * `agent_message`（见 codex `thread_history_projection.rs` 与 `rollout/src/policy.rs`
 * 的 `should_persist_event_msg`）。只写 `response_item` 时模型答得完全正确、
 * 界面却一片空白：实测 historyMode=paginated 的交接线程在 codex app-server 里
 * `turns: 0`、可见条目 0。所以两条通道都得写。
 *
 * 统一按 **paginated** 写：`threads.history_mode`、`session_meta.history_mode`、
 * 内容三者一致（这是 codex 0.157 自己 `migrate-rollouts` 的目标形态）。
 *
 * 工具调用**不**写进转录：`TurnItem` 的 CommandExecution 等枚举取值无从可靠复现，
 * 写错会让整份 rollout 反序列化失败（resume 直接崩），收益不抵风险；它们仍然完整
 * 保留在 `response_item` 里（模型看得到，我们已实测模型据此正确续跑）。
 *
 * 每行形状 `{timestamp, ordinal, type, payload}`（`function_call_output` 额外带行级
 * `metadata`）。`ordinal` 从 0 连续递增；时间戳单调不减（重复或倒流时 +1ms 修正）。
 */
import { randomBytes, randomUUID } from 'node:crypto';

/** 写进目标库的 `originator`：诚实标注来源，别冒充官方客户端。 */
export const HANDOFF_ORIGINATOR = 'dsh-session-handoff';
/** `cli_version` 位（codex 期望一个 semver 形态的字符串）。 */
export const HANDOFF_CLI_VERSION = '0.1.0-dsh-handoff';
/**
 * 本插件验证过的 `_sqlx_migrations` 最高版本（超出即中止，见 ADR-0002）。
 * 2026-09-26 在 codex-cli 0.157.1 上重新核对过 v57：`threads` 42 列，
 * 新增列（has_user_event / thread_section_id / section_position /
 * section_entered_at_ms / project_id / daybreak_enabled / creator_user_id /
 * creator_account_id）全部可空或有默认值，我们声明的必需列全部仍在。
 * 核对脚本：`node test/probe-schema.mjs`。
 */
export const VERIFIED_MAX_MIGRATION = 57;
/** 新格式 rollout 的 history_mode（界面转录走 item_completed）。 */
export const HANDOFF_HISTORY_MODE = 'paginated';
/** `TurnStartedEvent.collaboration_mode_kind` 的取值（codex `ModeKind`，默认 default）。 */
export const HANDOFF_COLLABORATION_MODE = 'default';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** codex 的 call_id 形如 `call_<24 位 base62>`。 */
export function newCallId() {
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i += 1) out += BASE62[bytes[i] % 62];
  return `call_${out}`;
}

/** 线程 id：全新 uuid（Q24:a 铸新 id，不覆盖源会话身份）。 */
export function newThreadId() {
  return randomUUID();
}

/** 本地时间戳（codex 的 rollout 文件名用本地时间）。 */
export function localStamp(ms) {
  const d = new Date(ms);
  const p = (n, width = 2) => String(n).padStart(width, '0');
  return {
    date: `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`,
    dir: [p(d.getFullYear(), 4), p(d.getMonth() + 1), p(d.getDate())],
  };
}

/** rollout 文件名：`rollout-YYYY-MM-DDTHH-mm-ss-<id>.jsonl`（本地时间）。 */
export function rolloutFileName(threadId, createdAtMs) {
  const stamp = localStamp(createdAtMs);
  return `rollout-${stamp.date}T${stamp.time}-${threadId}.jsonl`;
}

/** rollout 相对 `~/.codex` 的路径段：`sessions/YYYY/MM/DD/<file>`。 */
export function rolloutRelativeSegments(threadId, createdAtMs) {
  const stamp = localStamp(createdAtMs);
  return ['sessions', ...stamp.dir, rolloutFileName(threadId, createdAtMs)];
}

function isoStamp(ms) {
  return new Date(ms).toISOString();
}

function messagePayload(role, text, kind) {
  return {
    type: 'message',
    id: `msg_${randomUUID()}`,
    role,
    content: [{ type: kind, text }],
  };
}

/** 界面转录项：用户消息（`item_completed.item`）。形状照抄本机原生 paginated rollout。 */
export function userMessageTurnItem(text) {
  return {
    type: 'UserMessage',
    id: randomUUID(),
    client_id: randomUUID(),
    content: [{ type: 'text', text, text_elements: [] }],
  };
}

/** 界面转录项：助手消息。注意内层 content 的类型名是大写 `Text`（原生样本如此）。 */
export function agentMessageTurnItem(text) {
  return {
    type: 'AgentMessage',
    id: `resp_${randomUUID()}_msg`,
    content: [{ type: 'Text', text }],
  };
}

/**
 * 交给 codex 的 `arguments` 必须始终是一段合法 JSON 字符串（codex 会把它当 JSON 用）。
 * 参数被截断时不能把残缺 JSON 直接塞进去，改写成一个合法的、自带解释的对象，
 * 原始前缀原样保留在 `prefix` 里，既保真又不污染历史。
 */
function callArguments(item, sessionId) {
  if (item.argumentsTruncated !== true) return item.arguments;
  return JSON.stringify({
    _dsh_truncated: true,
    _dsh_omitted_bytes: item.omittedBytes ?? null,
    _dsh_source_session: sessionId ?? null,
    _dsh_note: '原参数过长已被截断，完整内容见源 DSH 会话日志。',
    prefix: item.arguments,
  });
}

/** 交接前言：交给 codex 的「这段历史从哪来」。 */
export function preambleText(ir, options = {}) {
  const source = ir.source;
  const lines = [
    '[会话交接] 下面这段历史由 DSH（DeepSeek Harness）会话转写而来。',
    `源会话 id: ${source.sessionId}`,
    source.title ? `源会话标题: ${source.title}` : undefined,
    source.cwd ? `源工作目录: ${source.cwd}` : undefined,
    options.handedOffAt ? `交接时间: ${isoStamp(options.handedOffAt)}` : undefined,
    `保真度: 对话文本 + 工具调用（参数截断 ${options.toolArgumentsMaxBytes ?? 2048} 字节）` +
      ` + 工具输出（每条截断 ${options.toolOutputMaxBytes ?? 8192} 字节） + 文件改动摘要；` +
      '不含附件与系统提示快照。',
    ir.fileChanges.length > 0
      ? `本会话涉及的文件（按操作次数）:\n${ir.fileChanges
          .slice(0, 40)
          .map((entry) => `  - ${entry.path} (${entry.count})`)
          .join('\n')}`
      : undefined,
    '继续任务时请在原工作目录下操作，并保持与上文一致的做法。',
  ];
  return lines.filter((line) => line !== undefined).join('\n');
}

/**
 * 生成 rollout 行。
 * @param {ReturnType<import('./ir.mjs').buildIntermediateRepresentation>} ir
 * @param {{threadId: string, createdAt: number, updatedAt?: number, cwd?: string,
 *          modelProvider?: string, cliVersion?: string, source?: string,
 *          modelContextWindow?: number | null,
 *          toolArgumentsMaxBytes?: number, toolOutputMaxBytes?: number}} options
 * @returns {{timestamp: string, ordinal: number, type: string, payload: object, metadata?: object}[]}
 */
export function buildRolloutLines(ir, options) {
  const threadId = options.threadId;
  const createdAt = options.createdAt;
  const cwd = options.cwd ?? ir.source.cwd ?? process.cwd();
  const source = ir.source;
  const modelContextWindow =
    typeof options.modelContextWindow === 'number' ? options.modelContextWindow : null;
  const lines = [
    {
      timestamp: isoStamp(createdAt),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: threadId,
        id: threadId,
        timestamp: isoStamp(createdAt),
        cwd,
        runtime_workspace_roots: [cwd],
        originator: HANDOFF_ORIGINATOR,
        cli_version: options.cliVersion ?? HANDOFF_CLI_VERSION,
        source: options.source ?? 'cli',
        thread_source: 'user',
        model_provider: options.modelProvider ?? source.provider ?? 'dsh',
        base_instructions: null,
        history_mode: HANDOFF_HISTORY_MODE,
      },
    },
  ];

  let lastTime = createdAt;
  /** 追加一行，返回解析后的毫秒时间戳（时间戳单调不减）。 */
  const push = (type, payload, time, metadata) => {
    const ms =
      typeof time === 'number' && Number.isFinite(time) ? Math.max(time, lastTime + 1) : lastTime + 1;
    lastTime = ms;
    const line = { timestamp: isoStamp(ms), ordinal: lines.length, type, payload };
    if (metadata !== undefined) line.metadata = metadata;
    lines.push(line);
    return ms;
  };

  const preamble = preambleText(ir, {
    handedOffAt: createdAt,
    toolArgumentsMaxBytes: options.toolArgumentsMaxBytes,
    toolOutputMaxBytes: options.toolOutputMaxBytes,
  });
  // 前言只进模型上下文（developer），不进界面转录：否则用户会在历史里看到一段
  // 自己没说过的话。
  push('response_item', messagePayload('developer', preamble, 'input_text'), createdAt);

  // ---- 界面转录的轮次状态机（paginated：task_started → item_completed → task_complete）
  const turnStats = { turns: 0, visibleItems: 0 };
  let turn = null;

  const openTurn = (startMs) => {
    const turnId = randomUUID();
    turn = { turnId, startedMs: startMs, firstTokenMs: null, lastAgentMessage: null };
    turnStats.turns += 1;
    push(
      'event_msg',
      {
        type: 'task_started',
        turn_id: turnId,
        root_turn_id: turnId,
        started_at: Math.floor(startMs / 1000),
        model_context_window: modelContextWindow,
        collaboration_mode_kind: HANDOFF_COLLABORATION_MODE,
      },
      startMs,
    );
  };

  const closeTurn = (endMs) => {
    if (turn === null) return;
    const completedMs = Math.max(endMs, turn.startedMs);
    push(
      'event_msg',
      {
        type: 'task_complete',
        turn_id: turn.turnId,
        last_agent_message: turn.lastAgentMessage,
        started_at: Math.floor(turn.startedMs / 1000),
        completed_at: Math.floor(completedMs / 1000),
        duration_ms: completedMs - turn.startedMs,
        time_to_first_token_ms: turn.firstTokenMs === null ? null : turn.firstTokenMs - turn.startedMs,
      },
      completedMs,
    );
    turn = null;
  };

  /** 把一个可见项同时写进两条通道。 */
  const pushVisible = (item, atMs) => {
    if (turn === null) return; // 没有所属轮次的孤立消息：只留在模型上下文里
    push(
      'event_msg',
      {
        type: 'item_completed',
        thread_id: threadId,
        turn_id: turn.turnId,
        item,
        started_at_ms: atMs,
        completed_at_ms: atMs,
      },
      atMs,
    );
    turnStats.visibleItems += 1;
  };

  // 待配对的 function_call（同一 callId 只配一次）与统计。
  const unpaired = new Map();
  let skippedOrphanResults = 0;

  for (const item of ir.items) {
    if (item.kind === 'user-message') {
      // 新的一轮：先收上一轮，再开这一轮。
      if (turn !== null) closeTurn(item.time ?? lastTime);
      const at = push('response_item', messagePayload('user', item.text, 'input_text'), item.time);
      if (turn === null) openTurn(at);
      pushVisible(userMessageTurnItem(item.text), at);
    } else if (item.kind === 'assistant-text') {
      const at = push('response_item', messagePayload('assistant', item.text, 'output_text'), item.time);
      if (turn !== null) {
        turn.lastAgentMessage = item.text;
        if (turn.firstTokenMs === null) turn.firstTokenMs = at - turn.startedMs;
        pushVisible(agentMessageTurnItem(item.text), at);
      }
    } else if (item.kind === 'tool-call') {
      const at = push(
        'response_item',
        {
          type: 'function_call',
          id: `fc_${randomUUID()}`,
          name: item.name,
          arguments: callArguments(item, source.sessionId),
          call_id: newCallId(),
        },
        item.time,
      );
      void at;
      // call_id 必须与随后的 function_call_output 配对：登记待配对表。
      const callLine = lines[lines.length - 1];
      callLine.payload.__dshCallId = item.callId;
      if (item.callId.length > 0 && !unpaired.has(item.callId)) unpaired.set(item.callId, callLine);
    } else if (item.kind === 'tool-result') {
      const owner = item.callId.length > 0 ? unpaired.get(item.callId) : undefined;
      if (owner === undefined) {
        // 没有可配对的调用：绝不伪造 call_id（那会留下悬空输出），跳过并计入 stats。
        skippedOrphanResults += 1;
        continue;
      }
      unpaired.delete(item.callId);
      const callId = owner.payload.call_id;
      push(
        'response_item',
        {
          type: 'function_call_output',
          id: `fco_${randomUUID()}`,
          call_id: callId,
          output: item.isError === true ? `[工具报错]\n${item.text}` : item.text,
        },
        item.time,
        { client_authored: false, fallback_token_limit_override: 12000 },
      );
    }
  }
  closeTurn(lastTime);

  const out = lines.map((line, index) => {
    const { __dshCallId, ...payload } = line.payload;
    void __dshCallId;
    return {
      timestamp: line.timestamp,
      ordinal: index,
      type: line.type,
      payload,
      ...(line.metadata !== undefined ? { metadata: line.metadata } : {}),
    };
  });
  out.stats = {
    orphanResults: skippedOrphanResults,
    unansweredCalls: unpaired.size,
    turns: turnStats.turns,
    visibleItems: turnStats.visibleItems,
  };
  return out;
}

/** 序列化为 JSONL（末尾带换行，codex 逐行读）。 */
export function serializeRollout(lines) {
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}
