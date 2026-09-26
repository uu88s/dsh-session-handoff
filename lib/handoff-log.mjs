/**
 * 交接记录（本地追加日志）。
 *
 * 位置：`$DSH_HOME/session-handoff/handoffs.jsonl`（一行一条 JSON）。
 * 用途（Q24:a）：撤销（知道要删哪个 rollout 文件与哪一行 threads）、
 * 重复交接检测（同一源会话是否已经交接过）、以及给人看的审计轨迹。
 * 只追加，不重写：任何一条记录都不覆盖历史。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDshHome } from './dsh-session.mjs';

export function handoffStoreDir(dshHome) {
  return join(resolveDshHome(dshHome), 'session-handoff');
}

export function handoffLogPath(dshHome) {
  return join(handoffStoreDir(dshHome), 'handoffs.jsonl');
}

/** 追加一条记录；返回写到磁盘上的对象。 */
export function appendHandoffRecord(record, dshHome) {
  const path = handoffLogPath(dshHome);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/** 读出所有记录（坏行跳过，不让半行毁掉整份日志）。 */
export function readHandoffRecords(dshHome) {
  const path = handoffLogPath(dshHome);
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 忽略损坏行。
    }
  }
  return records;
}

/** 最近一次成功交接（按顺序找最后一条 kind==='handoff' 且未被撤销的）。 */
export function latestHandoff(records, predicate = () => true) {
  const undone = new Set(records.filter((r) => r.kind === 'undo').map((r) => r.recordId));
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.kind !== 'handoff') continue;
    if (undone.has(record.recordId)) continue;
    if (!predicate(record)) continue;
    return record;
  }
  return undefined;
}

export function findHandoffRecord(records, recordId) {
  return records.find((record) => record.kind === 'handoff' && record.recordId === recordId);
}
