# 交接要同时喂两条通道：模型上下文与界面转录

用户的原始诉求是「`codex resume <id>` 以后接着干活」，而验收标准里隐含了一条我们起初没写下来的：**打开这个会话要看得到历史**。第一版交接只写了 `RolloutItem::ResponseItem`（模型真正读到的那条通道），结果用户在终端里 `codex resume edb0b84b-2999-4d64-9a2e-c771e023cd55` 看到的是一个**空白会话**：模型答得出上下文（回答里准确复述了 DSH 侧的需求确认、改过的文件、跑过的测试），屏幕上却什么都没有。

## 为什么一条 rollout 文件里有两条互不相干的通道

codex 的 rollout 是「按行追加的 `RolloutItem`」，但它有**两个消费者**，各自只认一类记录：

- **模型上下文**：`response_item`（`Message` / `function_call` / `function_call_output` / `reasoning` …），组装 prompt 时读它。我们第一版就是只写这一类。
- **界面转录**：`event_msg`。`codex-rs/history/src/lib.rs:412-435` 的 `InitialHistory::get_event_msgs()` 只挑 `RolloutItem::EventMsg`；`codex-rs/rollout/src/thread_history_projection.rs` 的文件头注释写得很直白——它只处理「新的 paginated rollout 格式里持久化的规范 `ItemCompleted(TurnItem)` 记录，不是 legacy 的 event-only rollout」，`project_rollout_line` 里 `SessionMeta | ResponseItem | TurnContext | TokenUsageRecord | WorldState | EventMsg(_)` 一律映射到空的 change set（即**界面上什么都不产生**）。

于是「resume 后模型知道上下文」和「resume 后界面显示历史」是两件独立的事，只喂一条通道就会出现本 ADR 开头那种「能答但看不见」的怪状态。

更进一步：`event_msg` 自己还有两种风格，由 `threads.history_mode` 决定，**内容与模式必须一致**：

| `history_mode` | 界面转录读什么 | 原生样本 |
| --- | --- | --- |
| `legacy` | `event_msg/user_message` + `event_msg/agent_message`（`codex-rs/rollout/src/policy.rs:94` `should_persist_event_msg` 里这些事件只在 `Legacy` 下持久化） | codex-tui 0.118–0.133、codex_cli_rs 0.117、Codex Desktop 0.131 |
| `paginated` | `event_msg/item_completed`（载荷是规范 `TurnItem`）+ `task_started` / `task_complete` | Codex Desktop 0.155.0-alpha.9.2 |

我们第一版的错误正是「**模式和内容不一致**」：`threads.history_mode` 与内部常量都写 `paginated`，文件里却一条 `item_completed` 都没有（且首行 `session_meta` 里根本没有 `history_mode` 字段，于是 codex 自己按 `legacy` 对待它）。用 codex 自己的 app-server 问它「这个线程的历史里有什么」，三次实测：

| 线程 | historyMode | 轮次 | 可见条目 |
| --- | --- | --- | --- |
| 我们的交接 `0f9227ea-5268-400f-9f5c-e55228fb3549` | paginated | 0 | 0 |
| 原生桌面会话 `01a0c489-5a5f-7c81-ae0f-03c0989913e5` | paginated | 2 | 25 |
| 用户报的 `edb0b84b-…` | legacy | 1 | 2（只有 codex 自己追写的那一轮） |

## 决定

**一次交接同时写两条通道、并让全链路的模式声明一致**：`threads.history_mode`、`session_meta.history_mode`、正文记录三者统一取 **`paginated`**。

- `session_meta` 显式带 `history_mode: "paginated"` 与 `base_instructions: null`（与 `codex migrate-rollouts --apply` 给旧会话补的字段一致），不再让 codex 靠缺省值猜。
- **模型上下文**：照旧写 `response_item`（对话文本、工具调用、工具输出）。
- **界面转录**：每轮写 `task_started` → 若干 `item_completed` → `task_complete`；可见条目只还原 **用户消息（`TurnItem::UserMessage`）与助手消息（`TurnItem::AgentMessage`）**，轮次 id 由我们新铸（`turn_id == root_turn_id`），时间戳取源事件时间并保证单调。

选 `paginated` 而不是 `legacy`，因为索引行本来就要写 `history_mode`，桌面版与 `codex migrate-rollouts` 的迁移方向都是 `legacy → paginated`，顺着走比逆着走安全。

## Considered Options

- **改回 `legacy`、写 `user_message` / `agent_message` 镜像事件**：拒绝。那是 codex 正在淘汰的格式（它自带迁移命令就是要把它搬走），且与我们在索引里写的 `paginated` 相冲突——冲突本身正是这次 bug 的成因。
- **顺手把工具调用也写成 `TurnItem::CommandExecution` 等条目，让界面连工具活动一起显示**：拒绝。`TurnItem` 的枚举取值与字段（`parsed_cmd` 的 `CommandAction` 变体、`source`、`status`）只能靠猜，而 rollout 是**整行反序列化**的：猜错一条，整个会话在 resume 时直接崩，代价远大于收益。工具调用留在 `response_item` 里（模型看得到），界面转录只保用户/助手消息。
- **同时写两套界面事件（legacy + paginated）**：拒绝。同一段对话会被投影两次，界面出现重复消息。
- **只写 paginated 但保留 `model_context_window` 等字段为空**：接受代价——这些字段只影响界面元信息，缺失比编造安全（`TurnStartedEvent`/`TurnCompleteEvent` 里它们都是 `Option`）。

## Consequences

- 界面转录的保真度是「用户 / 助手消息」，工具调用**不会**出现在 codex 的界面里（只在模型上下文里）。这条必须写进 README 的保真度表，不能让用户以为界面上的工具活动也是搬过来的。
- 旧格式交接出来的会话（`3e453060-…`、`edb0b84b-…`）界面仍然空白，修好的是**后续**交接；已存在的旧目标会话建议重新交接，或用 `--undo` 撤销。
- 我们的写入从此依赖 `TurnItem` 的形状。codex 升级后要复核的就不只是 `threads` 表（ADR-0002），还包括 `ItemCompleted` 的载荷：验收入口是 `node test/probe-transcript.mjs <threadId>`——它用 codex 自己的 app-server 问「这个线程的转录里有什么」，**修复前 0 轮 / 0 条，修复后 8 轮 / 32 条**，比读 JSONL 自证可靠。
- 两条通道必须始终一起写：任何「只写 response_item」的优化都会让界面重新变空，这正是本 ADR 要挡住的回归。
