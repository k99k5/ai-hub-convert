# 兼容性契约

## Public APIs

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `GET /health/live`
- `GET /health/ready`

网关无状态，不保存凭据、prompt、会话、conversation、response 或 token-count 结果。

## 路由与回退

| 入口 | 默认上游 | Chat 回退 |
| --- | --- | --- |
| Anthropic Messages JSON/SSE | Responses | 仅在明确 endpoint 不存在且零语义事件、零客户端写入时允许 |
| Anthropic count_tokens | Responses input_tokens | 永不回退 |
| OpenAI Responses JSON/SSE | Responses | 永不回退 |

明确 endpoint 不存在仅包括 HTTP 405、501，或携带 `route_not_found`、`endpoint_not_found`、`unsupported_endpoint`、`not_implemented` 的 HTTP 404。认证、限流、服务端错误、timeout/disconnect、model missing、模糊 404、HTTP 200 后 malformed SSE 都不会触发回退。

## 内容矩阵

| 能力 | Anthropic → Responses | Anthropic → Chat fallback | Responses → Responses |
| --- | --- | --- | --- |
| text / system | 支持 | 支持 | 支持 |
| URL image | 支持 | 支持 | 支持 |
| Base64 image | 支持 | 支持 | 支持 |
| function tools | 支持 | 支持 | 支持 |
| tool calls/results | 支持；`tool_result` 中的 image/search_result 内容返回 HTTP 400 | 同上；不触发 Chat 回退 | 支持 |
| parallel/interleaved calls | 支持 | 支持 | 支持 |
| reasoning/thinking | Anthropic thinking 可返回客户端；历史 thinking 不伪造成 Responses reasoning continuation | 支持常见 Chat reasoning 扩展 | 支持；真实 item `id` 与 `encrypted_content` 只作同协议 continuation |
| `output_config.effort` | `reasoning.effort` | `reasoning_effort` | 不适用；完整 `reasoning` 对象同协议回放 |
| `output_config.format` | `{type:"json_schema", schema}` → `text.format`；`responses/input_tokens` 同样保留；`null` 不发送格式约束 | → `response_format.json_schema` | 不适用 |
| `stop_sequences` | 丢弃（Responses 无对应参数） | `stop` | 不支持（无对应字段） |
| `top_k` | 丢弃（无对应参数） | 丢弃（无对应参数） | 不适用 |
| usage/cache-read/reasoning tokens | 支持已报告字段 | 支持已报告字段 | 支持已报告字段 |
| existing search_result | content 退化为 text | content 退化为 text | 支持规范化表示 |
| upstream refusal | 折为 text 块 + `stop_reason:"refusal"`；SSE 流中 refusal part 在 `output_item.done` 时并入文本块 | 同上 | JSON 保留原生 refusal part；SSE 流中折叠为 text delta |
| URL citations/annotations | JSON/SSE 支持；SSE 引用在文本块结束前输出，字段与 JSON 一致 | 受 Chat 扩展能力限制 | JSON/SSE 支持 |
| built-in Web Search execution | 网关 provider 执行；Anthropic 出口生成 `server_tool_use` / `web_search_tool_result` 并报告 `web_search_requests` | 网关 provider 执行；内部 function/tool-result round 后继续生成 | 网关 provider 执行；内部 function-result round 后继续生成 |
| ordinary function `web_search` | 普通 function | 普通 function | 普通 function |
| document/PDF | 不支持 | 不支持 | 不支持 |
| audio | 不支持 | 不支持 | 不支持 |
| file upload/file_id | 不支持 | 不支持 | 不支持 |
| background lifecycle | 不支持 | 不支持 | `background:true` 被拒绝 |

## Web Search discriminator

锁定 SDK 的 exact discriminator：

- Anthropic：`web_search_20250305`、`web_search_20260209`、`web_search_20260318`；
- OpenAI：`web_search`、`web_search_2025_08_26`、`web_search_preview`、`web_search_preview_2025_03_11`。

不使用 prefix matching。Anthropic `response_inclusion` 仅在 `web_search_20260318` 接受 `full | excluded`；OpenAI preview 只接受 preview contract 的 `search_content_types`，stable/versioned 类型使用 `filters.allowed_domains`。

内置 Web Search 由独立 provider registry 执行，当前 provider 为 DuckDuckGo。请求进入 canonical Web Search 后会 materialize 为网关保留的内部 function；上游模型发起该调用时，网关执行搜索、回填结果并继续 completion。Anthropic JSON/SSE 出口会把执行轨迹表示为原生 `server_tool_use` / `web_search_tool_result`，并同步 `usage.server_tool_use.web_search_requests`。网关自身生成的 server-search replay block 在后续 Anthropic 请求中会被识别并过滤，普通名为 `web_search` 的自定义 function 不会被当作内置搜索。

## Prompt cache

Anthropic `cache_control` 只进入 request-local positional sidecar，不进入 canonical IR extension bag。只有恰好落在 canonical tool/system/message 节点末端的 marker 才能保存；非终端、同节点重复、malformed、unsupported block marker 返回固定安全错误。

Claude Code cache policy 只有 strict SemVer 识别成功且范围内才启用。planner 最多输出四个断点；每个 Responses/Chat attempt 独立规划。generic provider capability 为 `none`，所以当前不会编码显式 cache metadata。`planned`、`encoded` 与 provider usage 报告的 hit/write 是三个不同状态。

`count_tokens` 不规划或发送 cache-write metadata。

## Reasoning 与 signature

- Anthropic `output_config.effort` 的 `low | medium | high | xhigh | max | null` 进入 canonical 请求：Responses 与 `responses/input_tokens` 编码为 `reasoning.effort`，Chat fallback 编码为 `reasoning_effort`；字段缺失时不发送。网关不预判目标模型支持的等级，也不从旧 `thinking.budget_tokens` 推断 effort。
- Anthropic `output_config.format` 接受 `null` 或 `{ type: "json_schema", schema: {...} }`。非 null 时 schema 进入 canonical structured-output 配置：Responses 与 `responses/input_tokens` 编码到 `text.format`，Chat fallback 编码到 `response_format.json_schema`。未知的 `output_config` 子字段、未知 format 类型、额外 format 字段或非 JSON object schema 都 fail-closed，返回 Anthropic HTTP 400。
- Anthropic 历史真实 signature 原样作为 opaque compatibility data 处理；缺失或空 signature 可由普通 Anthropic 客户端回传，不会导致请求被拒绝。
- Claude Code synthetic signature 是 UUID v4 文本的标准 Base64，不是 provider continuation。
- synthetic signature 不会写入 OpenAI `encrypted_content`。
- Anthropic thinking 没有 Responses reasoning item `id` 或 provider continuation，因此在 Anthropic → Responses 历史编码中省略；assistant text、function call 与匹配的 function result 仍按原顺序发送。Chat fallback 继续使用已识别的 `reasoning_content` 扩展。
- Responses 的真实 reasoning item `id` 和 `encrypted_content` 只允许同协议、kind=`reasoning`、非 synthetic continuation 回放；SSE 的 `encrypted_content` 在 `response.output_item.done` 提取。
- Responses `output_item.done` 的 item identity、完整正文/参数和 URL annotation 顺序必须与 added + delta 状态一致；校验使用固定大小 hash，不额外无界缓存正文。
- 已关闭的 Responses output index 与 Anthropic content block index 不可复用。

## 流与错误

- Anthropic SSE 顺序：`message_start → content block events → message_delta → message_stop`。
- Anthropic keepalive 使用命名 `event: ping`。
- Responses SSE 重新生成单调 `sequence_number`，终态后发送 `[DONE]`。
- 首帧前错误返回入口协议的 HTTP JSON；首帧后错误返回入口协议的流内 error。
- 三条 POST route 使用保留未知字段、禁止类型强转的浅层 wire schema；adapter 继续负责精确语义校验。schema 与 malformed JSON 返回入口协议的固定 HTTP 400，body 超限返回固定 HTTP 413。
- 单帧 SSE、成功 JSON body、错误外壳 body、单输出项/保留状态、整条流输出/状态、工具参数、请求 body、首字节等待、流 idle 与请求总时长都有上限；malformed upstream SSE UTF-8 fail-closed。
- 请求关闭、响应连接关闭、SSE reply 关闭和 graceful shutdown 均传播 AbortSignal 并取消上游 body。

## 已知有损语义

- canonical `incomplete` 映射 Anthropic `pause_turn`；`max_output_tokens` 映射 `max_tokens`。
- OpenAI `content_filter` 与上游 refusal 映射为 canonical `refusal`；Anthropic 出口将 refusal 折为 text 块并输出 `stop_reason:"refusal"`，Responses 流式透传中折叠为 text delta（非流式保留原生 refusal part）。
- Anthropic `tool_result` 中的 image/search_result 内容无法映射到 Responses `function_call_output` 或 Chat tool 消息，请求在调用上游前返回 HTTP 400，且不触发 Chat 回退。
- Anthropic `stop_sequences` 仅 Chat fallback 可表达（`stop`）；发往 Responses 上游时被丢弃。Anthropic `top_k` 在两条上游路径都无可表达字段，不转发。
- Anthropic citation 不伪造 encrypted index；仅保留可表达的 URL、title 与文本区间。
- Chat-compatible upstream 的 reasoning、citation 和 usage 扩展并非统一标准，只有已识别字段进入 canonical 表示。
- generic profile 不声明显式 prompt-cache 能力，因此依赖上游自动 prefix caching（如有），不伪造 breakpoint 等价关系。
