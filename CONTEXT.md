# Session Handoff

把一条 DSH 会话的完整历史交接到另一个 CLI agent（v1 只有 codex）里继续执行的上下文。

## Language

**会话 id (Session Id)**:
某个 agent 自己的会话库里唯一标识一条会话的字符串。
不同 agent 的会话 id 互不通用——在 codex 里 `resume` 一个 DSH 会话 id 没有任何意义。
_Avoid_: session key、token、uuid

**源会话 (Source Session)**:
DSH 会话库里的一条会话，是一次交接的起点。
_Avoid_: 原会话、当前会话、old session

**目标 agent (Target Agent)**:
接收交接、并能在自身会话库里恢复该会话的另一个 CLI agent。
_Avoid_: 对方、外部工具、target CLI

**目标会话 (Target Session)**:
一次交接在目标 agent 会话库里新建的会话，其内容源自源会话。
_Avoid_: 副本、镜像会话、导入会话

**转写 (Transcode)**:
把源会话的记录渲染成目标 agent 的记录格式；纯转换，不触碰任何 agent 的状态。
_Avoid_: 导出、转换器

**中间表示 (Intermediate Representation)**:
源会话摊平后的、与任何目标 agent 无关的对话记录（含工具调用与工具输出）；转写只从这个表示出发。
_Avoid_: 中间格式、IR 模型

**适配器 (Adapter)**:
针对某一个目标 agent 的转写与安置实现；只做四件事——读源会话、摊平成中间表示、写成目标记录、产出恢复凭据。
_Avoid_: 驱动、connector、后端

**导出 (Export)**:
DSH 既有的动作：把源会话产出一个文件或压缩包给人取用（`/export`、`export_chat`）；它可能顺带做了转写，但不做安置。
_Avoid_: 交接、迁移

**目标会话库 (Target Session Store)**:
目标 agent 用来发现会话的目录与索引；产物放错位置，等于没交接。
_Avoid_: 输出目录、exports 目录

**登记 (Registration)**:
把目标会话写进目标 agent 的索引（codex 是 `state_5.sqlite` 的 `threads` 表），使其能被该 agent 发现；这是整个交接里唯一会触碰既有文件的动作。
_Avoid_: 索引、入库、注册表

**交接 (Handoff)**:
一次转写，加上把产物安置进目标会话库，使其能被目标 agent resume（并产出恢复凭据）。
交接在写入那一刻**固化**源会话当时的内容：源会话之后继续加消息，目标会话不会跟着变长（目标 agent 不会回读源会话日志）；要拿到新内容只能重新交接一次。
_Avoid_: 迁移、同步、export/import、transfer

**保真度 (Fidelity)**:
一次交接在目标会话里保留了多少源会话内容，按类别衡量：对话文本、工具调用、工具输出、附件。
_Avoid_: 完整度、还原度

**模型上下文通道 (Model Context Channel)**:
目标 agent 的 rollout 里，喂给模型的那一半记录（codex 是 `response_item`）；决定 `resume` 后模型「记不记得」源会话。
_Avoid_: 历史、prompt、上下文

**界面转录通道 (Transcript Channel)**:
目标 agent 的 rollout 里，渲染给人看的那一半记录（codex 是 `event_msg`，且分 `legacy` 与 `paginated` 两种风格）；决定 `resume` 后界面「看不看得到」历史。两条通道互不相干，必须同时写，且模式声明要与内容一致。
_Avoid_: 显示、UI 日志、event 流

**恢复凭据 (Resume Handle)**:
交接产出的、在目标 agent 里恢复目标会话所需的凭据：目标会话 id，外加一条可直接粘贴执行的恢复命令。
_Avoid_: token、链接、resume 码

**交接记录 (Handoff Record)**:
一次交接留下的账：源会话 id、新铸的目标会话 id、写出的每个文件、登记的行，以及撤销它所需的全部信息。
_Avoid_: 日志、history、审计表
