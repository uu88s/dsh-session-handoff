# 会话交接（Session Handoff）

Status: resolved

## 背景

DSH 会话本身没有对外恢复凭据；用户希望在 DSH 里点一下就把**整个会话**交给别的 agent（v1 只做 codex），
在那边 `codex resume <id>` 能接着干同一个任务。

设计（不在本文件重复）：`CONTEXT.md`（术语表）、`docs/adr/0001-self-built-transcoder.md`、
`docs/adr/0002-register-in-target-index.md`。落地物：包根 `D:\tmp`（包名 `@uu88s/dsh-session-handoff`）。

## 验收标准（Q11）

1. 在 DSH 里干完活 → 点会话行右侧的交接图标（或会话头部「交接」按钮 / `…` 菜单 / `/handoff` / `handoff_session` 工具）；
2. 浮层先列出**将写入的文件**与**要登记的索引行**，确认后才写盘；
3. 写盘 = 目标 rollout 文件 + 目标索引库一行，只新增、不改既有数据；
4. `codex resume <新 id>` 能看到完整历史并继续改同一目录的文件；
5. 不想要了能撤销（删掉刚建的目标会话）。

## 验收结果（2026-09-27）

- `node test/smoke.mjs`：读会话日志 → IR → rollout 行 → 目标库预检 → 预演，全部通过（未写盘）。
- `node test/acceptance.mjs`：真写一次 → 独立校验文件与索引行 → 打印恢复凭据。
- `codex exec resume 3e453060-2cb0-40f5-873e-dfc8c85f3b52 --json "…"` 返回
  `{"type":"thread.started","thread_id":"3e453060-…"}` 与 `turn.completed input_tokens=187226` —— codex 真的把 18 万 token 的历史读进去了。
- `node test/e2e.mjs`：客户端半边（槽位注册 + 组件渲染 + 真实点击）→ 宿主路由 → 真写盘 → 撤销，10 步全绿。

## 已知限制

- v1 只做 codex；zcode / codebuddy 等适配器留到 v2（适配器接缝已经在 `lib/handoff.mjs` 里留好）。
- 保真度见 README 的表格：不转写附件内容、不转写 harness 上下文消息、不写 reasoning。
