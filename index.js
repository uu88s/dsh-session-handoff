/**
 * DSH 会话交接（Session Handoff）— 宿主半边。
 *
 * 三件事：
 *   1. 工具 `handoff_session`：让模型自己就能把当前会话交接给 codex；
 *   2. 斜杠命令 `/handoff`：人在输入框里手打；
 *   3. HTTP 路由 `POST /api/session-handoff`：给 Web 界面上的按钮用
 *      （客户端不 require 任何 Harness Client 包，只用浏览器全局 fetch）。
 *
 * 设计文档：CONTEXT.md、docs/adr/0001-self-built-transcoder.md、docs/adr/0002-register-in-target-index.md。
 */
import { readSessionLog, normalizeSessionId } from './lib/dsh-session.mjs';
import {
  HandoffError,
  describePlannedHandoff,
  executeHandoff,
  handoffToCodex,
  listHandoffs,
  planHandoff,
  undoHandoff,
} from './lib/handoff.mjs';

export const name = '@uu88s/dsh-session-handoff';
export const inject = ['tools', 'commands', 'connection'];

/** 客户端按钮调用的路由。 */
export const HANDOFF_ROUTE = '/api/session-handoff';

/** 预演 → 执行之间计划的保存时长（毫秒）；过期就重新预演。 */
const PLAN_TTL_MS = 10 * 60 * 1000;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 尽力从工具/命令上下文里问出「当前会话 id」。 */
function currentSessionId(holder) {
  const agent = holder?.agent ?? holder;
  const candidates = [
    agent?.sessionId,
    agent?.session?.sessionId,
    agent?.session?.id,
    agent?.id,
    process.env.DSH_SESSION_ID,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/**
 * 读源会话：优先用宿主现成的 sessionQuery（活会话也能读），失败再退回直读会话日志文件。
 */
async function readSessionViaHost(ctx, sessionId, dshHome) {
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
  if (query !== undefined && typeof query.readSession === 'function') {
    try {
      const snapshot = await query.readSession(sessionId);
      if (snapshot !== undefined && Array.isArray(snapshot.events) && typeof snapshot.session?.cwd === 'string') {
        return { header: snapshot.session, events: snapshot.events, via: 'sessionQuery' };
      }
    } catch {
      // 落到文件直读。
    }
  }
  const session = await readSessionLog(sessionId, { dshHome });
  return { ...session, via: 'log-file' };
}

function statsLine(stats) {
  if (stats === undefined || stats === null) return '';
  const parts = [];
  const map = [
    ['events', '事件'],
    ['userMessages', '用户消息'],
    ['assistantMessages', '助手消息'],
    ['toolCalls', '工具调用'],
    ['toolResults', '工具结果'],
    ['truncatedArguments', '截断参数'],
    ['truncatedOutputs', '截断输出'],
    ['skippedContextMessages', '跳过上下文消息'],
  ];
  for (const [key, label] of map) {
    if (typeof stats[key] === 'number') parts.push(`${label} ${stats[key]}`);
  }
  return parts.join('、');
}

function summaryText(described, { dryRun, record, via }) {
  const lines = [];
  lines.push(dryRun ? '交接预演完成（未写入任何文件）' : '交接完成：已把本会话转写成 codex 会话');
  lines.push(`  源会话：${described.sessionId}${via === undefined ? '' : `（读取方式：${via}）`}`);
  if (described.sourceTitle) lines.push(`  标题：${described.sourceTitle}`);
  lines.push(`  工作目录：${described.cwd}`);
  const stats = statsLine(described.stats);
  if (stats.length > 0) lines.push(`  转写：${stats}`);
  if (described.transcript !== undefined) {
    lines.push(
      `  界面历史：${described.transcript.turns} 轮 / ${described.transcript.visibleMessages} 条可见消息（resume 后在 codex 里直接看得到）`,
    );
  }
  lines.push(`  目标会话：${described.threadId}`);
  lines.push(`  将写入的文件（${described.files.length} 个）：`);
  for (const file of described.files) lines.push(`    ${file}`);
  for (const row of described.rows) lines.push(`  索引：${row}`);
  lines.push(
    `  保真度：模型上下文（对话全文 + 工具调用参数截断 2 KB + 工具结果单项 8 KB + 文件改动清单）；界面历史（用户 / 助手消息）`,
  );
  if (Array.isArray(described.warnings) && described.warnings.length > 0) {
    for (const warning of described.warnings) lines.push(`  ⚠ ${warning}`);
  }
  if (dryRun) {
    lines.push('');
    lines.push(`确认无误后执行，得到恢复凭据：${described.resumeCommand}`);
  } else {
    lines.push('');
    lines.push('在 codex 里继续这个任务：');
    lines.push(`  ${described.resumeCommand}`);
    if (record !== undefined) lines.push(`（撤销：/handoff --undo ${record.recordId}）`);
  }
  return lines.join('\n');
}

/** 宿主半边主体。 */
export function apply(ctx, config = {}) {
  const defaults = {
    dshHome: config.dshHome,
    codexHome: config.codexHome,
  };
  const plans = new Map();

  const rememberPlan = (planned) => {
    const token = planned.threadId;
    const now = Date.now();
    for (const [key, entry] of plans) {
      if (now - entry.at > PLAN_TTL_MS) plans.delete(key);
    }
    plans.set(token, { planned, at: now });
    return token;
  };

  const takePlan = (token) => {
    if (typeof token !== 'string' || token.length === 0) return undefined;
    const entry = plans.get(token);
    if (entry === undefined) return undefined;
    plans.delete(token);
    if (Date.now() - entry.at > PLAN_TTL_MS) return undefined;
    return entry.planned;
  };

  /** 统一的「预演 / 执行 / 撤销 / 列出」实现，工具、命令、路由共用。 */
  const run = async (action, input = {}, holder) => {
    const sessionId = normalizeSessionId(input.sessionId ?? currentSessionId(holder));
    const codexHome =
      typeof input.codexHome === 'string' && input.codexHome.length > 0 ? input.codexHome : defaults.codexHome;
    if (action === 'plan') {
      if (sessionId.length === 0) throw new HandoffError('缺少 sessionId', 'MISSING_SESSION_ID');
      const session = await readSessionViaHost(ctx, sessionId, defaults.dshHome);
      const planned = await planHandoff({ ...defaults, codexHome, sessionId, session });
      const described = describePlannedHandoff(planned);
      const planToken = rememberPlan(planned);
      return { action, dryRun: true, described, planToken, via: session.via };
    }
    if (action === 'handoff') {
      const reused = takePlan(input.planToken);
      if (reused !== undefined) {
        const executed = await executeHandoff(reused, { dshHome: defaults.dshHome });
        return {
          action,
          dryRun: false,
          described: executed.described,
          record: executed.record,
          via: 'plan-cache',
        };
      }
      if (sessionId.length === 0) throw new HandoffError('缺少 sessionId', 'MISSING_SESSION_ID');
      const session = await readSessionViaHost(ctx, sessionId, defaults.dshHome);
      const result = await handoffToCodex({ ...defaults, codexHome, sessionId, session });
      return { action, dryRun: false, described: result.described, record: result.record, via: session.via };
    }
    if (action === 'undo') {
      const result = await undoHandoff({
        ...defaults,
        codexHome,
        recordId: input.recordId,
        sessionId: input.sessionId,
        force: input.force,
      });
      return { action, undo: result };
    }
    if (action === 'list') {
      return { action, handoffs: listHandoffs({ dshHome: defaults.dshHome, sessionId: input.sessionId }) };
    }
    throw new HandoffError(`未知动作：${String(action)}`, 'UNKNOWN_ACTION');
  };

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'handoff_session',
        description:
          '把一个 DSH 会话交接给外部 agent（v1 只支持 codex）：转写成 codex 会话记录并登记到 codex 索引，' +
          '返回可直接粘贴的 `codex resume <id>` 恢复凭据。dryRun=true 时只预演、不写任何文件。',
        parameters: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', description: '要交接的 DSH 会话 id；缺省用当前会话' },
            dryRun: { type: 'boolean', description: '只预演，列出将写入的文件，不落盘' },
            codexHome: { type: 'string', description: 'codex 会话库目录，缺省 ~/.codex' },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              dryRun: { type: 'boolean' },
              sessionId: { type: 'string' },
              threadId: { type: 'string' },
              resumeCommand: { type: 'string' },
              rolloutPath: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
            },
            required: ['ok', 'text'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute(args, exec) {
          const input = args ?? {};
          const action = input.dryRun === true ? 'plan' : 'handoff';
          try {
            const result = await run(action, {
              sessionId: input.sessionId,
              codexHome: input.codexHome,
            }, exec);
            const described = result.described;
            const text = summaryText(described, {
              dryRun: result.dryRun,
              record: result.record,
              via: result.via,
            });
            const value = { ok: true, dryRun: result.dryRun, text };
            value.sessionId = described.sessionId;
            value.rolloutPath = described.rolloutPath;
            value.files = described.files;
            if (result.dryRun !== true) {
              value.threadId = described.threadId;
              value.resumeCommand = described.resumeCommand;
            }
            return value;
          } catch (error) {
            return { ok: false, text: `交接失败：${error.message}` };
          }
        },
      }),
    'session-handoff: handoff_session tool',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'handoff',
        description: '把本会话交接给 codex（可用 --dry-run 预演、--undo 撤销，撤销被拒时加 --force）',
        input: { hint: '[<sessionId>] [--dry-run] [--undo [--force]]' },
        handler: async (invocation) => {
          const raw = invocation.rawInput.trim();
          const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
          const flags = new Set(tokens.filter((token) => token.startsWith('--')));
          const positional = tokens.filter((token) => !token.startsWith('--'));
          try {
            if (flags.has('--undo')) {
              const result = await run(
                'undo',
                { recordId: positional[0], force: flags.has('--force') },
                invocation,
              );
              return {
                kind: 'success',
                text:
                  `已撤销交接 ${result.undo.recordId}：删除文件 ${result.undo.removedFile ? '是' : '否'}、` +
                  `索引行 ${result.undo.removedRows} 行。`,
              };
            }
            const sessionId = positional[0] ?? currentSessionId(invocation);
            const dryRun = flags.has('--dry-run');
            const result = await run(dryRun ? 'plan' : 'handoff', { sessionId }, invocation);
            return {
              kind: 'success',
              text: summaryText(result.described, {
                dryRun: result.dryRun,
                record: result.record,
                via: result.via,
              }),
            };
          } catch (error) {
            return { kind: 'error', text: `交接失败：${error.message}` };
          }
        },
      }),
    'session-handoff: /handoff command',
  );

  const connection = Reflect.get(ctx, 'connection');
  if (connection !== undefined && connection.fetch !== undefined) {
    connection.fetch.register({
      path: HANDOFF_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {};
        try {
          const text = await request.text();
          body = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
        }
        const action = typeof body.action === 'string' ? body.action : 'handoff';
        try {
          const result = await run(action, body);
          if (action === 'undo') return jsonResponse({ ok: true, ...result.undo });
          if (action === 'list') return jsonResponse({ ok: true, handoffs: result.handoffs });
          const described = result.described;
          return jsonResponse({
            ok: true,
            dryRun: result.dryRun,
            via: result.via,
            planToken: result.planToken,
            recordId: result.record?.recordId,
            described,
          });
        } catch (error) {
          return jsonResponse(
            {
              ok: false,
              error: error.message,
              code: error.code,
              preflight: error.preflight,
            },
            error.code === 'PREFLIGHT_FAILED' ? 409 : 400,
          );
        }
      },
    });
  }
}
