# 交接必须写进目标的索引，而不是只把文件放对位置

用户交接完要在终端跑 `codex resume <id>` 接着干活。而 codex 的会话列表走 `state_5.sqlite` 的 `threads` 表——`list_threads_with_db_fallback` 只在数据库报错时才回退到扫目录，回填器则一旦 `backfill_state.status == BackfillStatus::Complete` 就直接早退，本机的 `backfill_state` 早已是 `complete`（`last_success_at` 停在 2026-03-07）。所以"把 rollout 文件放进 `~/.codex/sessions/YYYY/MM/DD/` 就会被发现"是错的：本机现存的 9 个孤儿 rollout 文件（有文件、无 `threads` 行，全部由不登记的旧 SDK 写入）就是反例。

因此交接包含**登记**这一步：按 codex 自己的 `INSERT INTO threads`（31 列固定顺序、`ON CONFLICT(id) DO UPDATE`，幂等）向 `state_5.sqlite` 写一行，字段取值也照抄它的来源规则——`created_at` 取 `session_meta.timestamp`、`updated_at` 取文件 mtime、`recency_at` 同 `updated_at`，其余时间戳列由 codex 自己的触发器补。

这是整个交接里唯一会碰别人数据的动作，所以带三条护栏：**只 INSERT，绝不 UPDATE / DELETE 既有行**；动手前校验 `threads` 表结构与 `_sqlx_migrations` 版本，对不上就中止报错而不是硬写；交接前检测目标 agent 是否在运行并提示（WAL 下写写互斥，冲突会在 5 秒 busy timeout 后报 SQLITE_BUSY，新版还有 `~/.codex/thread-writer-locks/`）。

## Considered Options

- **只写文件、赌 codex 自己回填**：拒绝。回填已 `complete` 会早退，本机 9 个孤儿文件是实证。
- **只用 app-server 的 `thread/resume { path }` / `thread/fork { path }` 按文件接入**（官方通道，文件里自标 `[UNSTABLE]`）：不作为默认路径。它能让一次会话按路径恢复，但不登记线程，用户的常规入口 `codex resume <uuid>` 与 resume picker 仍然看不到这条会话。作为排障后的后备手段保留。

## Consequences

我们的交接因此依赖 codex 的内部数据库 schema。该 schema 在 npm CLI 0.144.5 与桌面版 0.155.0-alpha.9 之间已有差异（后者新增 writer lock 与 rollout 压缩，`_sqlx_migrations` 到 v55 而 0.144.5 内嵌只到 v40），所以实现里必须有版本探测与"对不上就拒绝"的分支，验收也必须在用户实际要用的那个 codex 上跑。

已核实的版本记录（每次都跑 `node test/probe-schema.mjs` 复核，核对通过才上调常量）：

| 日期 | codex 版本 | `_sqlx_migrations` | `threads` 列数 | 结论 |
| --- | --- | --- | --- | --- |
| 2026-04-10 | 0.144.5 / 桌面 0.155.0-alpha.9 | ≤ 55 | 40 | 必需列齐全，写入可用 |
| 2026-09-26 | codex-cli 0.157.1 | 57 | 42 | 必需列齐全；新增 8 列（`has_user_event`、`thread_section_id`、`section_position`、`section_entered_at_ms`、`project_id`、`daybreak_enabled`、`creator_user_id`、`creator_account_id`）全部可空或有默认值，原生行的取值也都是 0/null，我们无需写 |
