# 02 截断后的工具参数不是合法 JSON，会污染 codex 历史

Status: resolved

## 现象

冒烟测试直接 `JSON.parse(call.payload.arguments)` 抛
`SyntaxError: Unterminated string in JSON at position 1148`。

## 根因

保真度策略把工具参数截断到 2 KB（Q8:b）。截断点落在 JSON 字符串中间时，
写进 rollout 的 `arguments` 就是**残缺 JSON**；而 codex 会把它当 JSON 用（`serde_json::Value`），
残缺内容会污染历史、也可能让界面报错。

## 修复

- `lib/codex-rollout.mjs` 新增 `callArguments(item, sessionId)`：参数被截断时不再原样写入，
  改写成一个**合法且自解释**的对象，原始前缀完整保留：

  ```json
  {"_dsh_truncated":true,"_dsh_omitted_bytes":1234,"_dsh_source_session":"session-…",
   "_dsh_note":"原参数过长已被截断，完整内容见源 DSH 会话日志。","prefix":"<原始前缀>"}
  ```

## 验证

`node test/smoke.mjs` 与 `node test/e2e.mjs` 都会对**每一条** `function_call` 的 arguments 做 `JSON.parse`，
现在 198/198 全部可解析（本会话有 32 条被截断的参数）。
