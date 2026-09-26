/**
 * 读取 DSH 会话日志。
 *
 * 磁盘布局：`$DSH_HOME/sessions/--<projectKey(cwd)>--/<sessionId>/session.v4.jsonl[.zstd]`
 * 目录名就是会话 id，所以这里按 id 在 `sessions/*` 下直接找目录，不重算 projectKey；
 * 真实 cwd 从日志首行 header 取，因此无需反推路径编码规则（cwd 与目录名的一致性由
 * 首行 header 自己保证）。
 *
 * 日志格式：首行 header `{type:'session', version:4, id, createdAt, cwd, ...}`，
 * 其后每行 `{type, seq, time, data}`（部分事件附带 surfaceOp）。整份日志可能是
 * 多帧串联 zstd（见 zstd-frames.mjs），也可能是未压缩的纯文本。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decompressAllZstdFrames } from './zstd-frames.mjs';

/** 解析 DSH_HOME：显式参数 > 环境变量 > ~/.dsh。 */
export function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    return process.env.DSH_HOME;
  }
  return join(homedir(), '.dsh');
}

/** 所有会话按 cwd 分桶的根目录。 */
export function sessionsRoot(home) {
  return join(home, 'sessions');
}

/** 允许调用方传裸 uuid：DSH 主会话 id 形如 `session-<uuid>`。 */
export function normalizeSessionId(sessionId) {
  const raw = String(sessionId ?? '').trim();
  if (raw.length === 0) return raw;
  return raw.startsWith('session-') ? raw : `session-${raw}`;
}

/**
 * 在 sessions/* 下按会话 id 定位会话目录。
 * @returns {string | undefined}
 */
export function findSessionDir(sessionId, home = resolveDshHome()) {
  const id = normalizeSessionId(sessionId);
  if (id.length === 0) return undefined;
  const root = sessionsRoot(home);
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, id);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return undefined;
}

/**
 * 在会话目录里挑日志文件：优先 .zstd，其次 .zst，最后未压缩。
 * @returns {string | undefined}
 */
export function findSessionLog(sessionDir) {
  const names = readdirSync(sessionDir).filter((name) => name.startsWith('session.v4.jsonl'));
  if (names.length === 0) return undefined;
  const rank = (name) => (name.endsWith('.zstd') ? 0 : name.endsWith('.zst') ? 1 : 2);
  names.sort((a, b) => rank(a) - rank(b));
  return join(sessionDir, names[0]);
}

/**
 * 读取并解析一份会话日志。
 * @param {string} sessionId
 * @param {{dshHome?: string}} [options]
 * @returns {Promise<{header: object, events: object[], logPath: string, frameCount: number, torn: boolean, bytes: number, projectDir: string}>}
 */
export async function readSessionLog(sessionId, options = {}) {
  const home = resolveDshHome(options.dshHome);
  const id = normalizeSessionId(sessionId);
  const sessionDir = findSessionDir(id, home);
  if (sessionDir === undefined) {
    throw new Error(
      `找不到 DSH 会话 ${id}：${join(sessionsRoot(home), '*', id)} 下没有会话目录`,
    );
  }
  const logPath = findSessionLog(sessionDir);
  if (logPath === undefined) {
    throw new Error(`会话目录 ${sessionDir} 里没有 session.v4.jsonl* 日志文件`);
  }
  const buffer = readFileSync(logPath);
  let text;
  let frameCount = 0;
  let torn = false;
  if (logPath.endsWith('.zstd') || logPath.endsWith('.zst')) {
    const decoded = await decompressAllZstdFrames(buffer);
    text = decoded.content.toString('utf8');
    frameCount = decoded.frameCount;
    torn = decoded.torn;
  } else {
    text = buffer.toString('utf8');
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 追加写可能留下半行：跳过，不影响已经持久化的前缀。
    }
  }
  const header = rows[0];
  if (header === undefined || header.type !== 'session') {
    throw new Error(`会话日志 ${logPath} 的首行不是 session header`);
  }
  return {
    header,
    events: rows.slice(1),
    logPath,
    frameCount,
    torn,
    bytes: buffer.length,
    projectDir: sessionDir,
  };
}
