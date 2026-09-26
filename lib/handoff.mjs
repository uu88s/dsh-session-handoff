/**
 * 交接编排：读源会话 → 转写 → 预演 → 写入目标会话库 → 登记 → 记录 → 撤销。
 *
 * 对应 CONTEXT.md 的三个动作：导出（转写）、安置（写 rollout 文件）、登记（写 threads 行）。
 * 这里只做编排，具体格式都交给 lib/codex-*.mjs。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizeSessionId, readSessionLog } from './dsh-session.mjs';
import { buildIntermediateRepresentation } from './ir.mjs';
import {
  HANDOFF_CLI_VERSION,
  buildRolloutLines,
  newThreadId,
  serializeRollout,
} from './codex-rollout.mjs';
import {
  assertWritable,
  buildThreadRow,
  codexSessionsRoot,
  deleteThreadRow,
  openStateDatabase,
  planRolloutPath,
  preflight,
  registerThread,
  relativeToCodexHome,
  readCodexDefaults,
  removeRolloutFile,
  resolveCodexHome,
  stateDatabasePath,
  verifyRolloutFile,
  writeRolloutFile,
} from './codex-store.mjs';
import {
  appendHandoffRecord,
  findHandoffRecord,
  latestHandoff,
  readHandoffRecords,
} from './handoff-log.mjs';

/** 默认截断预算（Q8:b/c）。 */
export const DEFAULT_LIMITS = { toolArgumentsMaxBytes: 2048, toolOutputMaxBytes: 8192 };

export class HandoffError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function firstLine(text) {
  if (typeof text !== 'string') return '';
  const index = text.indexOf('\n');
  return (index === -1 ? text : text.slice(0, index)).trim();
}

/** DSH 的审批策略名 → codex 的 approval_mode 取值。 */
function approvalModeOf(policy) {
  if (typeof policy !== 'string' || policy.length === 0) return 'on-request';
  if (policy === 'never' || policy === 'deny' || policy === 'denied') return 'never';
  if (policy === 'on-failure') return 'on-failure';
  return 'on-request';
}

/**
 * 预演：不写任何东西，产出一个「计划」对象（含将要写入的字节内容）。
 * @param {{sessionId?: string, session?: object, dshHome?: string, codexHome?: string, now?: number, toolArgumentsMaxBytes?: number, toolOutputMaxBytes?: number}} input
 */
export async function planHandoff(input = {}) {
  const sessionId = normalizeSessionId(input.sessionId);
  if (sessionId.length === 0) throw new HandoffError('缺少 sessionId', 'MISSING_SESSION_ID');

  const session = input.session ?? (await readSessionLog(sessionId, { dshHome: input.dshHome }));
  const ir = buildIntermediateRepresentation(session, {
    toolArgumentsMaxBytes: input.toolArgumentsMaxBytes ?? DEFAULT_LIMITS.toolArgumentsMaxBytes,
    toolOutputMaxBytes: input.toolOutputMaxBytes ?? DEFAULT_LIMITS.toolOutputMaxBytes,
    now: input.now,
  });

  const codexHome = resolveCodexHome(input.codexHome);
  const report = preflight({ codexHome });
  if (!report.ok) {
    throw new HandoffError(report.errors.join('；'), 'PREFLIGHT_FAILED', { preflight: report });
  }
  // 登记进目标库的值必须是「目标 agent 自己能跑起来的」：provider/model 优先取 codex 自己的配置，
  // 否则 resume 会因为 provider 不存在而失败。
  const defaults = readCodexDefaults(codexHome);
  const modelProvider = input.modelProvider ?? defaults.modelProvider ?? ir.source.provider ?? 'dsh';

  const threadId = newThreadId();
  const createdAtMs = input.now ?? Date.now();
  const rolloutPath = planRolloutPath(codexHome, threadId, createdAtMs);
  const lines = buildRolloutLines(ir, {
    threadId,
    createdAt: createdAtMs,
    cwd: ir.source.cwd,
    modelProvider,
  });
  const content = serializeRollout(lines);

  const title =
    (typeof ir.source.title === 'string' && ir.source.title.trim().length > 0
      ? ir.source.title.trim()
      : undefined) ??
    firstLine(ir.source.firstUserText).slice(0, 80) ??
    `DSH 会话 ${ir.source.sessionId}`;

  const row = buildThreadRow({
    threadId,
    rolloutPath,
    createdAtMs,
    updatedAtMs: createdAtMs,
    cwd: ir.source.cwd,
    title,
    preview: firstLine(ir.source.firstUserText).slice(0, 200),
    firstUserMessage: firstLine(ir.source.firstUserText),
    modelProvider,
    model: defaults.model ?? ir.source.model ?? null,
    reasoningEffort: defaults.reasoningEffort ?? ir.source.reasoningEffort ?? null,
    sandboxType: defaults.sandboxMode ?? ir.source.sandboxMode ?? 'workspace-write',
    approvalMode: approvalModeOf(defaults.approvalPolicy ?? ir.source.approvalPolicy),
    cliVersion: HANDOFF_CLI_VERSION,
  });

  return {
    sessionId,
    ir,
    lines,
    content,
    row,
    preflight: report,
    threadId,
    createdAtMs,
    codexHome,
    dbPath: stateDatabasePath(codexHome),
    sessionsRoot: codexSessionsRoot(codexHome),
    rolloutPath,
    title,
    resumeCommand: `codex resume ${threadId}`,
  };
}

/** 转写过程中「少写了什么」的诚实提示。 */
function fidelityWarnings(planned) {
  const warnings = [];
  const stats = planned.ir.stats;
  const rollout = planned.lines.stats ?? {};
  if (stats.duplicateToolResults > 0) {
    warnings.push(`有 ${stats.duplicateToolResults} 条工具结果在 DSH 日志里是重复副本，已合并（保留更长的一份）`);
  }
  if (rollout.orphanResults > 0) warnings.push(`有 ${rollout.orphanResults} 条工具结果找不到对应调用，已跳过`);
  if (rollout.unansweredCalls > 0) warnings.push(`有 ${rollout.unansweredCalls} 次工具调用没有结果（可能被中断），只写了调用`);
  if (stats.truncatedArguments > 0) warnings.push(`有 ${stats.truncatedArguments} 条工具参数被截断到 2 KB`);
  if (stats.truncatedOutputs > 0) warnings.push(`有 ${stats.truncatedOutputs} 条工具输出被截断到 8 KB（已标注源会话 id）`);
  if (stats.skippedContextMessages > 0) {
    warnings.push(`有 ${stats.skippedContextMessages} 条 harness 上下文消息未转写（它们不是对话内容）`);
  }
  return warnings;
}

/** 把计划翻译成给人看/给模型看的摘要（不含文件内容）。 */
export function describePlannedHandoff(planned) {
  const { ir } = planned;
  return {
    sessionId: planned.sessionId,
    sourceTitle: planned.title,
    cwd: ir.source.cwd,
    threadId: planned.threadId,
    resumeCommand: planned.resumeCommand,
    codexHome: planned.codexHome,
    rolloutPath: planned.rolloutPath,
    relativeRolloutPath: relativeToCodexHome(planned.codexHome, planned.rolloutPath),
    dbPath: planned.dbPath,
    files: [`（新建）${planned.rolloutPath}`],
    rows: [`（新增）${planned.dbPath} → threads.id=${planned.threadId}`],
    lineCount: planned.lines.length,
    bytes: Buffer.byteLength(planned.content, 'utf8'),
    stats: ir.stats,
    // 界面转录（codex 里能看到的那串历史）：与模型上下文是两条独立通道，见 ADR-0003。
    transcript: {
      turns: planned.lines.stats?.turns ?? 0,
      visibleMessages: planned.lines.stats?.visibleItems ?? 0,
    },
    fileChanges: ir.fileChanges,
    warnings: [...planned.preflight.warnings, ...fidelityWarnings(planned)],
    fidelity: {
      dialogue: true,
      interfaceTranscript: '用户 / 助手消息（工具调用只在模型上下文里，不伪造 codex 的工具条目）',
      toolCalls: '参数截断到 2 KB',
      toolResults: '单项截断到 8 KB，并标注源 DSH 会话 id',
      reasoning: false,
      attachments: '只留占位行',
      fileChanges: '清单摘要（不搬内容）',
    },
  };
}

/**
 * 执行：写 rollout 文件 + 登记一行 threads。
 * 顺序：探活 → 写文件（wx，绝不覆盖）→ INSERT → 自检 → 记录。任一步失败都回滚已做的部分。
 */
export async function executeHandoff(planned, { dshHome } = {}) {
  if (existsSync(planned.rolloutPath)) {
    throw new HandoffError(`目标文件已存在，拒绝覆盖：${planned.rolloutPath}`, 'ROLLOUT_EXISTS');
  }
  const db = openStateDatabase(planned.dbPath);
  try {
    assertWritable(db);
    writeRolloutFile(planned.rolloutPath, planned.content, planned.sessionsRoot);
    let outcome;
    try {
      outcome = registerThread(db, planned.row);
    } catch (error) {
      removeRolloutFile(planned.rolloutPath);
      throw new HandoffError(`登记失败：${error.message}`, 'REGISTER_FAILED');
    }
    const verified = verifyRolloutFile(planned.rolloutPath, planned.threadId);
    const described = describePlannedHandoff(planned);
    const record = appendHandoffRecord(
      {
        kind: 'handoff',
        recordId: randomUUID(),
        at: new Date(planned.createdAtMs).toISOString(),
        source: {
          sessionId: planned.sessionId,
          cwd: planned.ir.source.cwd,
          title: planned.title,
          logPath: planned.ir.source.logPath ?? null,
          eventCount: planned.ir.stats.events,
        },
        target: {
          agent: 'codex',
          codexHome: planned.codexHome,
          threadId: planned.threadId,
          rolloutPath: relativeToCodexHome(planned.codexHome, planned.rolloutPath),
          dbPath: planned.dbPath,
          inserted: outcome.inserted,
          alreadyRegistered: outcome.alreadyRegistered,
        },
        resumeCommand: planned.resumeCommand,
        fidelity: described.fidelity,
        stats: planned.ir.stats,
        fileChanges: planned.ir.fileChanges,
        bytes: described.bytes,
        lines: verified.lines,
      },
      dshHome,
    );
    return { record, described, verified, inserted: outcome.inserted };
  } finally {
    db.close();
  }
}

/** 预演 + 执行（工具/命令/路由共用的入口）。 */
export async function handoffToCodex(input = {}) {
  const planned = await planHandoff(input);
  const described = describePlannedHandoff(planned);
  if (input.dryRun === true) return { planned, described, record: undefined, dryRun: true };
  const executed = await executeHandoff(planned, { dshHome: input.dshHome });
  return { planned, described, record: executed.record, dryRun: false, ...executed };
}

/** 撤销：删掉刚建的 rollout 文件与那一行 threads，并记一条 undo。 */
export async function undoHandoff(input = {}) {
  const records = readHandoffRecords(input.dshHome);
  const record = input.recordId
    ? findHandoffRecord(records, input.recordId)
    : latestHandoff(records, (item) =>
        input.sessionId === undefined ? true : item.source?.sessionId === input.sessionId,
      );
  if (record === undefined) throw new HandoffError('找不到可撤销的交接记录', 'UNDO_NOT_FOUND');

  const codexHome = resolveCodexHome(input.codexHome ?? record.target?.codexHome);
  const stored = record.target?.rolloutPath ?? '';
  const rolloutPath = isAbsolute(stored) ? stored : join(codexHome, stored);

  if (existsSync(rolloutPath) && input.force !== true) {
    const info = statSync(rolloutPath);
    const created = Date.parse(record.at ?? '') || 0;
    if (info.mtimeMs > created + 60_000) {
      throw new HandoffError(
        `目标会话文件在交接后被改动过（${new Date(info.mtimeMs).toLocaleString()}），` +
          '可能已经在 codex 里继续过；确认要删就带 force。',
        'UNDO_MODIFIED',
      );
    }
  }

  let removedFile = false;
  if (existsSync(rolloutPath)) {
    removeRolloutFile(rolloutPath);
    removedFile = true;
  }

  let removedRows = 0;
  const dbPath = stateDatabasePath(codexHome);
  if (existsSync(dbPath) && typeof record.target?.threadId === 'string') {
    const db = openStateDatabase(dbPath);
    try {
      assertWritable(db);
      removedRows = deleteThreadRow(db, record.target.threadId, record.target.rolloutPath ?? rolloutPath);
      if (removedRows === 0) {
        removedRows = deleteThreadRow(db, record.target.threadId, rolloutPath);
      }
    } finally {
      db.close();
    }
  }

  appendHandoffRecord(
    {
      kind: 'undo',
      recordId: record.recordId,
      at: new Date().toISOString(),
      removedFile,
      removedRows,
      rolloutPath,
      threadId: record.target?.threadId ?? null,
    },
    input.dshHome,
  );

  return {
    recordId: record.recordId,
    sessionId: record.source?.sessionId ?? null,
    threadId: record.target?.threadId ?? null,
    rolloutPath,
    removedFile,
    removedRows,
  };
}

/** 列出交接记录（可只列某个源会话的）。 */
export function listHandoffs({ dshHome, sessionId } = {}) {
  const records = readHandoffRecords(dshHome);
  const undone = new Set(records.filter((record) => record.kind === 'undo').map((record) => record.recordId));
  return records
    .filter((record) => record.kind === 'handoff')
    .filter((record) => sessionId === undefined || record.source?.sessionId === sessionId)
    .map((record) => ({
      recordId: record.recordId,
      at: record.at,
      sessionId: record.source?.sessionId ?? null,
      threadId: record.target?.threadId ?? null,
      resumeCommand: record.resumeCommand,
      undone: undone.has(record.recordId),
      lines: record.lines ?? null,
      bytes: record.bytes ?? null,
    }));
}
