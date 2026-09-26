/**
 * codex 会话库（目标会话库）的读写与登记。
 *
 * 目标库 = `$CODEX_HOME`（默认 `~/.codex`）：
 *   - 会话记录落 `sessions/YYYY/MM/DD/rollout-<本地时间>-<id>.jsonl`；
 *   - 索引是 `state_5.sqlite` 的 `threads` 表（0.157.1 上 42 列、5 个
 *     AFTER INSERT/UPDATE 触发器，`_sqlx_migrations` 最高版本 57）。
 *
 * ADR-0002 的三条护栏都在这里：
 *   1. 只 INSERT 自己新铸的那一行 id，绝不改写别人的行；
 *   2. 先校验表结构（必需的 NOT NULL 列齐全）与 `_sqlx_migrations` 版本，否则中止；
 *   3. 写前用 `BEGIN IMMEDIATE` 探测目标库是否被占用（codex 可能在跑），被占用即中止。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HANDOFF_HISTORY_MODE, HANDOFF_ORIGINATOR, VERIFIED_MAX_MIGRATION, rolloutRelativeSegments } from './codex-rollout.mjs';

/** codex 会话库根：显式参数 > CODEX_HOME > ~/.codex。 */
export function resolveCodexHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.length > 0) {
    return process.env.CODEX_HOME;
  }
  return join(homedir(), '.codex');
}

/** codex 落库时对目录做了 `\\?\` 长路径前缀（本机实测），登记时保持一致。 */
export function codexCwd(cwd) {
  if (process.platform !== 'win32') return cwd;
  return cwd.startsWith('\\\\?\\') ? cwd : `\\\\?\\${cwd}`;
}

/** 建表时必须我们提供的列（NOT NULL 且无默认值）。缺一即中止。 */
export const REQUIRED_THREAD_COLUMNS = [
  'id',
  'rollout_path',
  'created_at',
  'updated_at',
  'source',
  'model_provider',
  'cwd',
  'title',
  'sandbox_policy',
  'approval_mode',
];

/** 其余可选列：表里有就写，没有就跳过（跨 codex 版本兼容）。 */
export const OPTIONAL_THREAD_COLUMNS = [
  'recency_at',
  'created_at_ms',
  'updated_at_ms',
  'recency_at_ms',
  'history_mode',
  'thread_source',
  'model',
  'reasoning_effort',
  'cli_version',
  'preview',
  'tokens_used',
  'first_user_message',
  'archived',
  'archived_at',
  'git_sha',
  'git_branch',
  'git_origin_url',
  'memory_mode',
  'name',
  'originator',
  'is_pinned',
  'agent_nickname',
  'agent_role',
  'agent_path',
];

export function stateDatabasePath(codexHome) {
  const home = resolveCodexHome(codexHome);
  const exact = join(home, 'state_5.sqlite');
  if (existsSync(exact)) return exact;
  try {
    const candidates = readdirSync(home)
      .map((name) => /^state_(\d+)\.sqlite$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => ({ name: match[0], version: Number(match[1]) }))
      .sort((a, b) => b.version - a.version);
    if (candidates.length > 0) return join(home, candidates[0].name);
  } catch {
    // 目录读不了就退回默认名，让 preflight 去报错。
  }
  return exact;
}

/**
 * 读 codex 的 config.toml 顶层配置，只取 resume 真正会用到的几个键。
 * 解析失败一律当空对象：宁可少写，也不要猜错 provider。
 */
export function readCodexDefaults(codexHome) {
  const home = resolveCodexHome(codexHome);
  const path = join(home, 'config.toml');
  const result = {};
  if (!existsSync(path)) return result;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return result;
  }
  const keys = {
    model_provider: 'modelProvider',
    model: 'model',
    model_reasoning_effort: 'reasoningEffort',
    approval_policy: 'approvalPolicy',
    sandbox_mode: 'sandboxMode',
  };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break; // 顶层键只在第一个 section 之前
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (match === null) continue;
    const target = keys[match[1]];
    if (target === undefined) continue;
    const value = match[2].trim().replace(/^["'](.*)["']$/s, '$1');
    if (value.length > 0) result[target] = value;
  }
  return result;
}

export function codexSessionsRoot(codexHome) {
  return join(codexHome, 'sessions');
}

/** rollout 绝对路径。 */
export function planRolloutPath(codexHome, threadId, createdAtMs) {
  return join(codexHome, ...rolloutRelativeSegments(threadId, createdAtMs));
}

function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((row) => String(row.name));
}

/**
 * 只读预检。任何硬失败都返回 ok:false + errors，不抛异常（调用方决定怎么呈现）。
 */
export function preflight({ codexHome } = {}) {
  const home = resolveCodexHome(codexHome);
  const result = {
    ok: true,
    codexHome: home,
    dbPath: stateDatabasePath(home),
    sessionsRoot: codexSessionsRoot(home),
    columns: [],
    migrationVersion: undefined,
    errors: [],
    warnings: [],
  };
  const fail = (message) => {
    result.ok = false;
    result.errors.push(message);
  };
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    fail(`找不到 codex 会话库目录：${home}（设 CODEX_HOME 或 --codex-home 可覆盖）`);
    return result;
  }
  if (!existsSync(result.sessionsRoot)) {
    fail(`目标会话库缺少 ${result.sessionsRoot}：拒绝凭空创建目录（Q21:a）`);
  }
  if (!existsSync(result.dbPath)) {
    fail(`找不到 codex 索引库：${result.dbPath}`);
    return result;
  }

  let db;
  try {
    db = new DatabaseSync(result.dbPath, { readOnly: true });
  } catch (error) {
    fail(`打开 codex 索引库失败：${error.message}`);
    return result;
  }
  try {
    const tables = tableColumns(db, 'sqlite_master');
    void tables;
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    if (!names.includes('threads')) {
      fail(`${result.dbPath} 里没有 threads 表（不是 codex 索引库？）`);
      return result;
    }
    result.columns = tableColumns(db, 'threads');
    for (const column of REQUIRED_THREAD_COLUMNS) {
      if (!result.columns.includes(column)) fail(`threads 表缺少必需列 ${column}，拒绝写入`);
    }
    if (names.includes('_sqlx_migrations')) {
      const row = db.prepare('SELECT MAX(version) AS v FROM _sqlx_migrations').get();
      const version = row?.v === null || row?.v === undefined ? undefined : Number(row.v);
      result.migrationVersion = version;
      if (version !== undefined && version > VERIFIED_MAX_MIGRATION) {
        fail(
          `codex 索引库 schema 版本 ${version} 高于本插件验证过的 ${VERIFIED_MAX_MIGRATION}，` +
            '拒绝按旧结构写入（升级 codex 后请同步更新插件）',
        );
      }
    } else {
      result.warnings.push('索引库里没有 _sqlx_migrations，无法核对 schema 版本');
    }
  } catch (error) {
    fail(`读取 codex 索引库结构失败：${error.message}`);
  } finally {
    db.close();
  }
  return result;
}

/** 探测索引库是否被别的写者占用（护栏 3）。 */
export function assertWritable(db) {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (error) {
    throw new Error(`codex 索引库当前被占用（codex 可能正在运行）：${error.message}`);
  }
}

export function openStateDatabase(dbPath) {
  return new DatabaseSync(dbPath);
}

/**
 * 组装 threads 行。列名 → 值；只写目标表真实存在的列。
 */
export function buildThreadRow(input) {
  const createdAt = Math.floor(input.createdAtMs / 1000);
  const updatedAt = Math.floor(input.updatedAtMs / 1000);
  const sandboxPolicy = JSON.stringify({ type: input.sandboxType ?? 'workspace-write' });
  return {
    id: input.threadId,
    rollout_path: input.rolloutPath,
    created_at: createdAt,
    updated_at: updatedAt,
    recency_at: updatedAt,
    created_at_ms: input.createdAtMs,
    updated_at_ms: input.updatedAtMs,
    recency_at_ms: input.updatedAtMs,
    source: input.source ?? 'cli',
    history_mode: HANDOFF_HISTORY_MODE,
    thread_source: 'user',
    model_provider: input.modelProvider ?? 'dsh',
    model: input.model ?? null,
    reasoning_effort: input.reasoningEffort ?? null,
    cwd: codexCwd(input.cwd),
    cli_version: input.cliVersion,
    title: input.title,
    preview: input.preview,
    sandbox_policy: sandboxPolicy,
    approval_mode: input.approvalMode ?? 'on-request',
    tokens_used: 0,
    first_user_message: input.firstUserMessage,
    archived: 0,
    archived_at: null,
    git_sha: null,
    git_branch: null,
    git_origin_url: null,
    memory_mode: 'enabled',
    name: input.name ?? null,
    originator: HANDOFF_ORIGINATOR,
    is_pinned: 0,
  };
}

export function readThreadRow(db, threadId) {
  const columns = tableColumns(db, 'threads');
  const wanted = ['id', 'rollout_path', 'cwd', 'title', 'created_at_ms', 'updated_at_ms'].filter((column) =>
    columns.includes(column),
  );
  return db.prepare(`SELECT ${wanted.join(', ')} FROM threads WHERE id = ?`).get(threadId);
}

/**
 * 登记一行 threads（只碰我们新铸的 id）。
 * @returns {{inserted: boolean, alreadyRegistered: boolean}}
 */
export function registerThread(db, row) {
  const columns = tableColumns(db, 'threads');
  const existing = readThreadRow(db, row.id);
  if (existing !== undefined) {
    if (String(existing.rollout_path) === String(row.rollout_path)) {
      return { inserted: false, alreadyRegistered: true };
    }
    throw new Error(
      `目标库里已存在 id=${row.id} 的线程但 rollout_path 不一致（${existing.rollout_path}），拒绝改写`,
    );
  }
  const names = Object.keys(row).filter((column) => columns.includes(column));
  const placeholders = names.map(() => '?').join(', ');
  const sql = `INSERT INTO threads (${names.join(', ')}) VALUES (${placeholders})`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(sql).run(...names.map((column) => row[column]));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`登记 threads 行失败：${error.message}`);
  }
  return { inserted: true, alreadyRegistered: false };
}

/** 撤销用：只删「id 与 rollout_path 都对得上」的那一行。 */
export function deleteThreadRow(db, threadId, rolloutPath) {
  const info = db.prepare('DELETE FROM threads WHERE id = ? AND rollout_path = ?').run(threadId, rolloutPath);
  return Number(info.changes ?? 0);
}

/** 写 rollout 文件：若已存在则失败（永不覆盖，Q9:b）；只允许补建日期目录。 */
export function writeRolloutFile(rolloutPath, content, sessionsRoot) {
  const dir = dirname(rolloutPath);
  if (!existsSync(dir)) {
    if (!existsSync(sessionsRoot)) {
      throw new Error(`目标会话库缺少 ${sessionsRoot}：拒绝创建目录（Q21:a）`);
    }
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(rolloutPath, content, { encoding: 'utf8', flag: 'wx' });
}

export function removeRolloutFile(rolloutPath) {
  if (existsSync(rolloutPath)) unlinkSync(rolloutPath);
}

/** 读回刚写的 rollout 做自检（首行必须是 session_meta，且 id 一致）。 */
export function verifyRolloutFile(rolloutPath, threadId) {
  const text = readFileSync(rolloutPath, 'utf8');
  const first = JSON.parse(text.slice(0, text.indexOf('\n')));
  if (first?.type !== 'session_meta') {
    throw new Error(`rollout 首行不是 session_meta：${String(first?.type)}`);
  }
  if (first.payload?.id !== threadId && first.payload?.session_id !== threadId) {
    throw new Error(`rollout 首行 id 与登记的线程 id 不一致：${String(first.payload?.id)}`);
  }
  return { lines: text.split('\n').filter((line) => line.length > 0).length };
}

/** 供 handoff 记录使用：把相对路径写进日志，方便人读。 */
export function relativeToCodexHome(codexHome, absolutePath) {
  return absolutePath.startsWith(codexHome) ? absolutePath.slice(codexHome.length + 1) : absolutePath;
}

void appendFileSync;
