# 转写层自己写，不复用 dsh-chat-import 的序列化器

交接要把 DSH 会话渲染成 codex 的 rollout JSONL，而本机已装的第三方插件 `dsh-chat-import` 看起来已经做了这件事：`export_chat(format:"codex")` 能写出 rollout 文件，它的纯函数 `serializeCodexJsonl({meta,events,sessionUuid,cwd})` 也能直接 import。我们还是决定自己实现转写层，因为它的产物不是一条合规的 codex 会话记录——只输出 `session_meta` + `response_item` 两类行（真实文件有 8 类：`event_msg`、`turn_context`、`world_state`、`token_usage_record` 等全缺），`originator='dsh-chat-import'`、`source='dsh'` 不在 codex 的枚举里，缺 `cli_version` / `base_instructions` / `model_provider`，reasoning 与图片被直接丢弃，补丁只作为裸参数流传，且直接复用源会话 id。复用它等于先接受一个错的输出再逐项打补丁，而补丁范围覆盖它的全部输出版图——"复用"只剩名义上的节省。

它对我们仍有价值，但只是**参考实现**：它证明了 codex 的字段级结构可以照抄。

## Considered Options

- **复用 `export_chat` 的 codex 分支**：拒绝。输出既不符合我们定的保真度规则（工具参数截断 2KB、工具输出截断 8KB 并标注原文位置、附件留绝对路径占位、丢弃 reasoning），也不符合 codex 的 schema。
- **把它作为可选后端、缺失时回退自研**：拒绝。两套输出路径意味着两套测试和两套缺陷，而它并不满足最低要求，回退路径永远会赢。

## Consequences

codex 的 rollout schema 变化时由我们自己跟进。这是整个项目里唯一会随外部工具版本腐烂的部分，因此它必须隔离在适配器内部，并配一个以**真实 codex 会话文件**为金标准的对照测试。
