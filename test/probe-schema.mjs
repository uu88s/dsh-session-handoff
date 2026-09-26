/**
 * 查 codex 索引库当前 schema：迁移版本、threads 列（含 NOT NULL 无默认值的「必填列」）、
 * 触发器。codex 升级后会改库结构，本插件的 VERIFIED_MAX_MIGRATION 就是靠它核对后上调。
 *
 * 用法：node test/probe-schema.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveCodexHome, stateDatabasePath } from '../lib/codex-store.mjs';
import { REQUIRED_THREAD_COLUMNS, OPTIONAL_THREAD_COLUMNS } from '../lib/codex-store.mjs';

const home = resolveCodexHome();
const dbPath = stateDatabasePath(home);
console.log(`codexHome: ${home}`);
console.log(`state 库 : ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true });

const migrations = db
  .prepare('SELECT version, description, success FROM _sqlx_migrations ORDER BY version')
  .all();
console.log(`\n迁移版本：${migrations.length} 条，最高 ${migrations[migrations.length - 1]?.version}`);
for (const row of migrations.slice(-6)) {
  console.log(`  ${row.version}  ${row.success ? '' : '✗ '}${row.description}`);
}

const columns = db.prepare('PRAGMA table_info(threads)').all();
console.log(`\nthreads 列：共 ${columns.length} 列`);
const requiredNow = columns
  .filter((row) => row.notnull === 1 && row.dflt_value === null && row.pk === 0)
  .map((row) => String(row.name));
console.log(`NOT NULL 且无默认值（我们建行时必须提供）：${requiredNow.join(', ')}`);
const missing = requiredNow.filter((name) => !REQUIRED_THREAD_COLUMNS.includes(name));
if (missing.length > 0) console.log(`  ✗ 我们还没提供：${missing.join(', ')}`);
const vanished = REQUIRED_THREAD_COLUMNS.filter((name) => !columns.some((row) => row.name === name));
console.log(`  我们声明必需但现在不存在的列：${vanished.length === 0 ? '（无）' : vanished.join(', ')}`);
const unknownOptional = OPTIONAL_THREAD_COLUMNS.filter((name) => !columns.some((row) => row.name === name));
console.log(`  可选列中本库没有的：${unknownOptional.length === 0 ? '（无）' : unknownOptional.join(', ')}`);
const foreign = columns
  .map((row) => String(row.name))
  .filter((name) => !REQUIRED_THREAD_COLUMNS.includes(name) && !OPTIONAL_THREAD_COLUMNS.includes(name));
console.log(`  本插件不认识的列（新版本新增）：${foreign.length === 0 ? '（无）' : foreign.join(', ')}`);

const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='threads'").all();
console.log(`\nthreads 触发器：${triggers.map((row) => row.name).join(', ') || '（无）'}`);
const total = db.prepare('SELECT COUNT(*) AS n FROM threads').get();
console.log(`线程总数：${total.n}`);

const added = db
  .prepare('SELECT id, history_mode, source, originator, cli_version FROM threads ORDER BY created_at DESC LIMIT 5')
  .all();
console.log('\n最近 5 个线程：');
for (const row of added) {
  console.log(`  ${row.id} mode=${row.history_mode} source=${row.source} originator=${row.originator} cli=${row.cli_version}`);
}

// 新版新增列在真实行里的取值：判断我们要不要跟着写（例如 has_user_event）。
if (foreign.length > 0) {
  const sample = db
    .prepare(`SELECT originator, ${foreign.join(', ')} FROM threads ORDER BY created_at DESC LIMIT 8`)
    .all();
  console.log('\n新增列的实际取值：');
  for (const row of sample) console.log(`  ${row.originator} ->`, JSON.stringify(row));
}
db.close();
