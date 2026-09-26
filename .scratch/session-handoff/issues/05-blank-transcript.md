# 05 交接后的会话在 codex 里看不到历史

Status: resolved

## 现象

用户原话：`为什么我输入codex resume edb0b84b-2999-4d64-9a2e-c771e023cd55，会话历史没有展示出来呢`。

模型侧完全正常——`codex exec resume` 的提问能准确复述 DSH 侧的需求确认、改过的文件与跑过的测试，`input_tokens` 18 万——但终端里打开这个会话是**空的**：没有用户消息、没有助手回答。

## 根因

codex 的 rollout 有**两个互不相干的消费者**，第一条 rollout 只喂了其中一个（详见 ADR-0003）：

- 模型上下文读 `response_item`（我们写了，所以模型「记得」）；
- 界面转录读 `event_msg`，**一条都没写**，所以界面空白。

雪上加霜的是模式声明自相矛盾：索引行 `threads.history_mode` 与内部常量都写 `paginated`（`lib/codex-rollout.mjs` 的 `HANDOFF_HISTORY_MODE`），而首行 `session_meta` 里根本没有 `history_mode` 字段，文件内容也一条 `item_completed` 都没有——codex 于是按 `legacy` 处理它，而 legacy 要的 `user_message` / `agent_message` 同样不存在。

用 codex 自己的 app-server 问「这个线程的转录里有什么」，三次实测：

| 线程 | historyMode | 轮次 | 可见条目 |
| --- | --- | --- | --- |
| 我们的交接 `0f9227ea-5268-400f-9f5c-e55228fb3549` | paginated | 0 | 0 |
| 原生桌面会话 `01a0c489-5a5f-7c81-ae0f-03c0989913e5` | paginated | 2 | 25 |
| 用户报的 `edb0b84b-…` | legacy | 1 | 2（只有 codex 自己追写的那一轮） |

## 修复

- `lib/codex-rollout.mjs`：一次交接同时写两条通道；`session_meta` 显式带 `history_mode: "paginated"` + `base_instructions: null`，与索引行一致；每轮写 `task_started` → `item_completed`（`TurnItem::UserMessage` / `AgentMessage`）→ `task_complete`。
- 工具调用**不**伪装成 codex 的工具条目（枚举只能猜，猜错会让整份 rollout 反序列化失败、resume 直接崩），只留在模型上下文里。
- `lib/handoff.mjs` / `index.js`：计划与完成摘要里打印「界面历史：N 轮 / M 条可见消息」，让用户一眼看出界面通道写了没有。
- 新增验收工具 `test/probe-transcript.mjs`（codex app-server JSON-RPC），把「界面里能不能看到历史」变成可自动判定的检查。

## 验证

- `node test/acceptance.mjs`（真写）：源 `session-e181bce7-…` → 新线程 `2e61001f-c804-409c-ab26-04ee7f1191a9`，785 行 / 1315874 字节，校验全绿（`✓ 界面转录通道 — 8 轮 / 32 条可见消息`、`✓ 历史模式 — history_mode=paginated`）。
- `node test/probe-transcript.mjs 2e61001f-c804-409c-ab26-04ee7f1191a9`：`historyMode paginated`、**8 轮 / 32 条可见条目**（修复前同一探针 0 轮 / 0 条）。
- `codex exec resume 2e61001f-… --json "不要执行任何命令，只回复：已恢复"`：`thread.started` + `agent_message「已恢复」` + `input_tokens=306867` —— 两条通道同时为真。
- `node test/smoke.mjs`（823 行 / 30 条可见消息）、`node test/e2e.mjs`（10 步全过）重跑通过。

## 遗留

修复前交接出来的旧目标会话界面仍然空白，需要重新交接。清理情况：`3e453060-…` 已撤销；取证实验线程 `0f9227ea-…` 已强制撤销（`--force`，因为它被 `codex migrate-rollouts` 改过）；`edb0b84b-…` 保留未删（里面有你自己的追问「会话恢复了吗」），要清掉可以 `/handoff --undo 5436682c-db88-4eae-b67e-15f55e2baf7e --force`。
