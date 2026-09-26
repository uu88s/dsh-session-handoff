# @uu88s/dsh-session-handoff — 会话交接

DSH Web 插件。做两件事：

1. **复制会话 id**：在侧边栏会话行右侧的 hover 图标或 `…` 菜单里，一键复制 DSH 会话 id。
2. **交接给 codex**：把整个 DSH 会话（对话文本 + 工具调用 + 工具输出 + 文件变更清单）转写成一个 **codex 能 `resume` 的会话**，写进 codex 的会话库并登记进它的索引，最后给出可粘贴的恢复命令 `codex resume <新 id>`。

> 只复制 id 是不够的：codex 的 `resume` 只认自己库里的会话。交接 = 读源会话 → 展平成中间表示 → 写成目标 agent 的原生记录 → 登记进目标索引 → 给出恢复凭据。

## 安装

```bash
dsh plugin install @uu88s/dsh-session-handoff   # 从 npm 安装
dsh plugin install /绝对路径/到/本包             # 或从本地目录安装（plugin_manager 的 install_bundle，target 传绝对目录）
```

npm 不可达时，改用 GitHub Release 里的 `uu88s-dsh-session-handoff-0.1.0.tgz`：

```bash
curl -L -o handoff.tgz https://github.com/uu88s/dsh-session-handoff/releases/download/v0.1.0/uu88s-dsh-session-handoff-0.1.0.tgz
tar -xzf handoff.tgz
dsh plugin install /绝对路径/到/package
```

源码：<https://github.com/uu88s/dsh-session-handoff>；问题反馈：<https://github.com/uu88s/dsh-session-handoff/issues>。

安装后 client 半边改动可免刷新生效（依赖 `dsh-client-hmr` 的轮询）；**host 半边改 JS 需要重启 DSH**。

## 用法

| 入口 | 位置 | 作用 |
| --- | --- | --- |
| 会话行 hover 图标 | 侧边栏会话行右侧 | 交接给 codex |
| 会话行 `…` 菜单 | 同上 | ① 复制 DSH 会话 id ② 交接给 codex |
| 会话头部「交接」按钮 | 会话标题右侧 | 交接给 codex |
| `/handoff` 命令 | 输入框 | `[<sessionId>] [--dry-run] [--undo [--force]]` |
| `handoff_session` 工具 | 模型可调用 | `{sessionId?, dryRun?, codexHome?}` |

交接是**两步式**：先预演（列出将新建的 rollout 文件与将插入的索引行），确认后才写入。完成后 Toast 上给三个按钮：复制恢复命令、撤销这次交接、关闭。

## 安全性

- **只增不改**：永不覆盖已存在的文件（`flag: 'wx'`），永不改写索引里已有的行；同一会话只对应一个新的目标会话。
- **预检**：写入前校验 codex 家目录、`state_*.sqlite`、`threads` 表、必需列、schema 版本（`_sqlx_migrations` 不得高于已核实的 57），并用 `BEGIN IMMEDIATE` 探测库是否被占用；预检失败直接报错，不会悄悄建目录。
- **可撤销**：撤销 = 删掉刚建的 rollout 文件 + 删掉刚插入的 `threads` 行（按 `id` + `rollout_path` 双条件），并在交接记录里留痕。文件被外部改动过则拒绝撤销（需 `force`）。
- **留痕**：每次交接/撤销都追加到 `$DSH_HOME/session-handoff/handoffs.jsonl`，用于撤销与重复交接检测。

## 保真度（v1）

| 内容 | 是否转写 |
| --- | --- |
| 用户 / 助手对话文本 | ✅（模型上下文 + 界面转录两条通道都写） |
| codex 界面里显示的历史 | ✅ 用户 / 助手消息；工具活动**不**进界面（不伪造 codex 的工具条目，见 ADR-0003） |
| 工具调用（名称 + 参数，参数超 2 KB 截断并标注） | ✅ |
| 工具输出（单条超 8 KB 截断，标注原 DSH 会话 id） | ✅ |
| 文件变更清单（从工具参数里抽取的路径） | ✅（汇总进前言 + 计划） |
| reasoning / 思考过程 | ❌ |
| 附件图片、系统提示快照 | ❌（附件仅以绝对路径占位一行） |

交接会话的 `cwd` 默认等于源会话的 `cwd`（同一工作区继续干活）；`originator` 标记为 `dsh-session-handoff`，`cli_version` 标记为 `0.1.0-dsh-handoff`，便于日后区分来源。

## 交接是快照：源会话后来长了怎么办

交接在写入那一刻**固化**源会话当时的内容，之后源会话继续加消息，目标线程**不会**跟着变长（目标是一个独立会话，codex 不会回读 DSH 日志）。

要拿到后来的内容，**重新交接一次**：每次交接都新造一个目标会话 id，不会覆盖或追加到旧目标线程（Q20:a，见 ADR-0001）。旧目标线程可以留着继续用，也可以 `/handoff --undo <记录 id>` 撤掉。

实测（源会话 `session-e181bce7-…`）：

| 交接时刻 | 目标线程 | 写入规模 | 界面转录 |
| --- | --- | --- | --- |
| 17:16 | `2e61001f-…` | 783 行 / 1.3 MB | 8 轮 / 32 条 |
| 18:05（源会话已变长） | `40c65068-…` | 1053 行 / 1.75 MB | 11 轮 / 39 条 |

第一次交接**之后**才在源会话里出现的文字（例如「左边的文字」「npm/GitHub」）在 `2e61001f` 的转录里查不到，在重新交接出来的 `40c65068` 里**查得到**——两条通道（模型上下文 / 界面转录）都带上了新内容。

## 适配器范围

v1 只实现 **codex**（本机唯一可 `resume` 的 CLI agent）。适配器接缝只有四件事：读源会话 / 展平成中间表示 / 写目标记录 / 给出恢复凭据；zcode、codebuddy 等属于 v2。

反方向（外部会话 → DSH）由官方 `dsh-chat-import` 负责，本插件不重复实现。

## 测试与验收

`test/` 不进发布包，三个脚本都不需要浏览器，也不需要正在运行的 DSH：

| 脚本 | 做什么 | 写盘？ |
| --- | --- | --- |
| `node test/smoke.mjs [sessionId]` | 读本机会话日志 → 中间表示 → rollout 行（逐条校验行类型、配对、时间戳、arguments 可解析）→ 目标库预检 → 预演 | 只读 |
| `node test/e2e.mjs [sessionId]` | 在 node 里装一个最小 React + 渲染器，**真渲染**客户端注册的组件、按真实路径点击按钮（复制 id / 开始写入 / 复制恢复命令 / 撤销 / 错误态）→ 宿主路由 → 写一次真会话 → 再撤销 | 写一次并撤销 |
| `node test/acceptance.mjs [--dry\|--undo]` | 真写一次并**独立**校验 rollout 首行与索引行（含两条通道与 `history_mode`），打印 `codex resume <id>` | 写一次（`--dry` 不写） |
| `node test/probe-transcript.mjs <id>…` | 用 codex 自己的 app-server 问「这条会话的转录里有什么」（轮次 + 可见条目）——界面通道的验收判据 | 只读 |
| `node test/probe-schema.mjs` | 只读打开 `state_5.sqlite`：迁移版本、`threads` 列、必需列、触发器、本插件不认识的列及原生取值 | 只读 |

已实测（2026-09-27，codex-cli 0.157.1）：

- `codex exec resume <新 id> --json "…"` 返回 `{"type":"thread.started","thread_id":"<新 id>"}` 与
  `turn.completed input_tokens=306867` —— codex 把转写出来的三十万 token 历史读了进去并正常回答（模型上下文通道）。
- `node test/probe-transcript.mjs <新 id>` 返回 `historyMode paginated`、**8 轮 / 32 条可见条目**，内容就是源会话里的用户/助手消息（界面转录通道）。修复前同一探针是 **0 轮 / 0 条**。

## 已知限制

- 界面转录只还原用户 / 助手消息：codex 的工具条目（`TurnItem::CommandExecution` 等）枚举取值只能靠猜，而 rollout 是整行反序列化的，猜错一条会让整个会话在 `resume` 时直接崩——所以工具调用只留在模型上下文里，界面里不显示。`reasoning` 同样不写。
- 写入依赖 codex 的 `TurnItem` 载荷形状与 `history_mode` 语义（ADR-0003）。升级 codex 后除了用 `probe-schema` 复核 `threads` 表，还要用 `probe-transcript` 复核界面转录；形状对不上时宁可停下报错，不硬写。
- 本插件**修复前**交接出来的目标会话（只有模型上下文、界面空白）不会自动变好，需要重新交接一次；旧的可以用 `/handoff --undo` 撤销。
- 目标侧必须存在可用的 codex 状态库；若目标 agent 正在运行，登记可能遇到 `SQLITE_BUSY`（预检会先探测）。
- 撤销不会动 DSH 源会话，也不会动 `~/.codex/session_index.jsonl`（它只是名字索引，不是 resume 入口）。

## 许可

MIT
