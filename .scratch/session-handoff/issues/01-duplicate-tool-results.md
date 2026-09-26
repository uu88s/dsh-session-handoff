# 01 重复的工具结果被当成孤儿，产出悬空 function_call_output

Status: resolved

## 现象

第一次真跑 `planHandoff`（本会话，198 次调用 / 197 条结果）时，写出的 rollout 里有
**13 条 `function_call_output` 找不到配对的 `function_call`**（198 调用 vs 189 输出里含 13 条伪造）。

## 根因

DSH 会话日志里同一个 `callId` 可能出现**两条 `tool/result`**：一条全量（8~50 KB），
一条约 5 KB 的截断副本（实测 14 个 callId 各 2 条，前缀相同）。旧实现按「一个 callId 配一次结果」处理，
第二条就被当成孤儿，于是**伪造了一个新 call_id** 去配对。

## 修复

- `lib/ir.mjs`：`tool/result` 按 callId 去重，**保留更长的一条**，重复计数进 `stats.duplicateToolResults`。
- `lib/codex-rollout.mjs`：配对表改为待配对 Map；**配不上就跳过并计数**（`stats.orphanResults`），绝不伪造 call_id。
- `lib/handoff.mjs`：`fidelityWarnings()` 把重复合并数 / 孤儿结果 / 无结果调用写进预演警告。

## 验证

`node test/smoke.mjs`：调用 198、输出 197、无结果 1、悬空输出 **0**；预演警告里出现「14 条工具结果…已合并」。
