# 兼容性契约

## Public APIs

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`、`POST /responses`
- `GET /v1/responses`、`GET /responses`（WebSocket Upgrade）
- `POST /v1/chat/completions`、`POST /chat/completions`
- `/v1/conversations` 及其会话、历史项管理接口
- `GET /v1/usage`
- `GET /v1/models`
- `GET /health/live`
- `GET /health/ready`

网关不持久化凭据、prompt、会话、conversation、response 或 token-count 结果。Responses 引用续轮使用短期输出项缓存，HTTP `previous_response_id` 使用独立的有界短期历史缓存；WS 响应 ID 历史另在连接内保留，断线即清理。Conversations 使用独立的有界内存存储，可在 HTTP 和 WS 之间共用，默认空闲 30 分钟、删除或进程重启清理。存储键只保存凭据的 HMAC 散列，WS 仅在存活连接处理上游请求时保留握手凭据。

## 路由与回退

| 入口 | 默认 Chat 模式 | 显式 Responses 模式 |
| --- | --- | --- |
| Anthropic Messages JSON/SSE | 直接 Chat，不回退或重试 | Responses；仅明确 endpoint 不存在且零语义事件、零客户端写入时回退 Chat |
| Anthropic count_tokens | HTTP 501，不调用上游 | Responses input_tokens；永不回退 |
| OpenAI Responses JSON/SSE | 直接 Chat，不回退或重试 | Responses；永不回退 |
| OpenAI Responses WebSocket | 连接历史或 conversation 展开后走 Chat HTTP/SSE | 连接历史或 conversation 展开后走 Responses HTTP/SSE |
| OpenAI Chat Completions JSON/SSE | 直接 Chat，不回退或重试 | 直接 Chat，不回退或重试 |

`UPSTREAM_PROTOCOL` 只接受 `chat`（默认）或 `responses`。Chat 模式不探测 Responses，所有失败直接结束该请求；内置搜索所需的模型续轮仍全部使用 Chat。Responses 模式中的明确 endpoint 不存在仅包括 HTTP 405、501，或携带 `route_not_found`、`endpoint_not_found`、`unsupported_endpoint`、`not_implemented` 的 HTTP 404。认证、限流、服务端错误、timeout/disconnect、model missing、模糊 404、HTTP 200 后 malformed SSE 都不会触发回退。

### 强制 Chat 模式（默认）

三个生成入口均在网关完成协议转换，上游仅接收 `/chat/completions`，Bearer 凭据和请求模型保持既有规则。自动或显式 `prompt_cache_key` 直接写进 Chat 请求，显式 null 仍抑制自动生成；不依赖中间层完成 Responses → Chat 字段映射。

| Responses 入口能力 | Chat 上游行为 |
| --- | --- |
| instructions、文本、图片、函数工具 | 转为 Chat 消息和工具定义；图片精度保留 auto/low/high，original 在出站前返回 400 |
| 并行调用和工具结果 | 同一 assistant 轮次的 reasoning/text/function_call 合并为一个 Chat assistant 消息，随后附上对应 tool 消息 |
| `reasoning.effort` | 映射到 `reasoning_effort`；保留 none/minimal/low/medium/high/xhigh/max/null，模型支持范围由上游判断 |
| `text.format` / `text.verbosity` | 映射到 `response_format` / `verbosity`；JSON Schema 名称、描述、strict 和 schema 保留 |
| 推理内容 | Chat `reasoning_content` 转为 Responses 明文 summary；不生成加密内容，不承诺 summary 等显示控制。`include` 中的加密推理选项不发给 Chat；只有 encrypted_content、无明文 summary 的历史返回 400 |
| `store` / `metadata` | HTTP 映射到 Chat 同名字段，store 缺省 false；本地续轮不依赖 store，不提供 Responses 存储检索 API；WS 强制 store:false |
| `client_metadata` | HTTP/WS 接受 JSON 对象或 `null`，校验后丢弃；不转发、不并入 `metadata` 或会话历史，两种上游模式相同 |
| `previous_response_id` | HTTP 展开同凭据、同模型的缓存历史；WS 展开本连接同模型的最近成功响应。未命中返回 `previous_response_not_found`，客户端可发送完整历史 |
| JSON/SSE 输出 | 网关生成独立响应及输出项 ID；文本、推理、工具、拒绝、截断状态转换回 Responses，流式终态完整校验后才发送 |
| 缓存和推理用量 | Chat prompt_tokens_details.cached_tokens/cache_write_tokens 转为 Responses input_tokens_details；reasoning_tokens 保留，缺失字段不补零 |
| 网页搜索 | 保留网关 provider 执行、搜索进度、来源、引用及累计用量，模型轮次全部走 Chat |

`count_tokens` 在此模式下返回 Anthropic HTTP 501；不访问 Responses input_tokens，也不通过一次生成调用或本地算法估算。`/usage`、`/models` 继续透传。切换上游协议会改变自动缓存键的目标接口部分；显式键保持原值。部署无需数据迁移，显式设置 `UPSTREAM_PROTOCOL=responses` 可恢复原协议路由；重启会清空本地引用缓存。

## 读取接口透传

- 仅开放 `GET /v1/usage` 和 `GET /v1/models`，对应启动配置 `UPSTREAM_BASE_URL` 下的 `usage` 和 `models`；保留配置中的路径前缀，不自动追加第二个 `/v1`。其他路径、子路径和请求方法不转发。
- 接受 `Authorization: Bearer ...` 或 `x-api-key`；同时提供时必须一致。上游只接收转换后的 Bearer 和 `Accept: application/json`，不转发客户端 Cookie 或其他请求头。
- 保留查询中的重复参数、参数顺序和已有百分号编码；特殊字符遵循标准 URL 编码。网关不解释额度字段、不映射模型、不汇总或缓存结果。
- 上游状态码和正文按原始字节返回，包括错误正文、非 JSON 和空响应；不进入协议转换或错误清洗。保留 `Content-Type`、`Retry-After` 和 `X-Request-Id` 响应头，其他上游响应头不转发。
- 成功正文受 `UPSTREAM_JSON_BODY_LIMIT_BYTES` 限制，其余正文受 `UPSTREAM_ERROR_BODY_LIMIT_BYTES` 限制。读取超限、连接失败或超时返回现有 OpenAI 格式的网关错误，不返回部分正文。
- 复用请求总超时与客户端断连取消；不跟随上游重定向，不重试或回退。上游没有用量接口时原样返回其错误，网关不推算额度或重置时间。

## 内容矩阵

以下矩阵描述各转换器；Responses → Chat 以先前的默认模式表为准。

| 能力 | Anthropic → Responses | Anthropic → Chat（默认及回退） | Responses → Responses |
| --- | --- | --- | --- |
| text / system | 支持 | 支持 | 支持 |
| URL image | 支持 | 支持 | 支持 |
| Base64 image | 支持 | 支持 | 支持 |
| function tools | 支持 | 支持 | 支持 |
| tool calls/results | 支持；`tool_result` 中的 image/search_result 内容返回 HTTP 400 | 同上；不触发 Chat 回退 | 支持；`function_call_output.output` 接受字符串或纯 `input_text` 数组，图片和文件结果返回 HTTP 400 |
| parallel/interleaved calls | 支持 | 支持 | 支持 |
| reasoning/thinking | Anthropic thinking 可返回客户端；历史 thinking 不伪造成 Responses reasoning continuation | 支持常见 Chat reasoning 扩展 | 支持；真实 item `id` 与 `encrypted_content` 只作同协议 continuation |
| `output_config.effort` | `reasoning.effort` | `reasoning_effort` | 不适用；`reasoning` 中的 `context`、`effort`、`generate_summary`、`mode`、`summary` 同协议回放 |
| `output_config.format` | `{type:"json_schema", schema}` → `text.format`；`responses/input_tokens` 同样保留；`null` 不发送格式约束 | → `response_format.json_schema` | 不适用 |
| `text.format` / `text.verbosity` | 不适用 | 不适用 | 支持 text/json_object/json_schema；保留名称、schema、description、strict 的缺省/null/false/true 以及 verbosity |
| 图片 `detail` | 默认 auto | 未指定精度 | 保留 auto/low/high/original；非法值在上游调用前返回 400 |
| 函数工具 `strict` | 沿用 Anthropic 的显式设置，缺省 false | 同左 | 保留缺省/null/false/true；不将缺省强制设为 false |
| `stop_sequences` | 丢弃（Responses 无对应参数） | `stop` | 不支持（无对应字段） |
| `top_k` | 丢弃（无对应参数） | 丢弃（无对应参数） | 不适用 |
| usage/cache-read/reasoning tokens | 支持已报告字段 | 支持已报告字段 | 支持已报告字段 |
| existing search_result | content 退化为 text | content 退化为 text | 支持规范化表示 |
| upstream refusal | 折为 text 块 + `stop_reason:"refusal"`；SSE 流中 refusal part 在 `output_item.done` 时并入文本块 | 同上 | JSON 保留原生 refusal part；SSE 流中折叠为 text delta |
| URL citations/annotations | JSON/SSE 支持；SSE 引用在文本块结束前输出，字段与 JSON 一致 | 受 Chat 扩展能力限制 | JSON/SSE 支持 |
| built-in Web Search execution | 网关 provider 执行；Anthropic 出口生成 `server_tool_use` / `web_search_tool_result` 并报告 `web_search_requests` | 网关 provider 执行；内部 function/tool-result round 后继续生成 | 网关执行，返回 `web_search_call`、SSE 搜索进度、按需来源与链接引用 |
| ordinary function `web_search` | 普通 function | 普通 function | 普通 function |
| document/PDF | 不支持 | 不支持 | 不支持 |
| audio | 不支持 | 不支持 | 不支持 |
| file upload/file_id | 不支持 | 不支持 | 不支持 |
| background lifecycle | 不支持 | 不支持 | `background:true` 被拒绝 |

Responses 的工具结果文本数组按原顺序直接拼接为字符串，保留空白和换行，不自动插入分隔符；空数组归一化为空字符串。JSON 与 SSE 请求采用相同规则，适用于客户端执行普通搜索函数后的结果回传。混入图片、文件或未知内容类型时整条请求返回 HTTP 400，不会仅提取文字并丢弃其他内容。

Anthropic `tool_result.is_error:true` 在 Responses 和 Chat 上游的结果正文中编码为 JSON 字符串 `{"is_error":true,"output":"原始结果文本"}`；成功结果继续保持原文，包括空白和换行。不会在 OpenAI 工具结果对象上增加协议不支持的字段。发往 Responses 的历史中，文本、图片与工具调用按原顺序编码，只合并连续的文本和图片内容。

### Codex Responses 工具兼容

Responses 入口在 Chat 和 Responses 两种上游模式中均接受 Codex GUI 的以下工具格式，覆盖 HTTP JSON、SSE 和 WebSocket：

| 输入 | 转换与返回 |
| --- | --- |
| `namespace` | 展开组内的 function/custom 工具，用稳定别名区分不同命名空间和工具类型；保留组说明与工具说明。调用返回时恢复原 `name`、`namespace` 和 `call_id` |
| `custom` | 转成参数为 `{ "input": "原始文本" }` 的普通函数；返回时拆出字符串，恢复 `custom_tool_call.input`。不把 JSON 包装暴露给客户端 |
| `input.additional_tools` | 仅接受 `role:"developer"` 与工具数组，按输入顺序收集声明，同一工具以后面的声明为准；不作为聊天正文转发。声明保留在本地输入历史中，可随 HTTP/WS 续轮与 Conversations 继承 |
| `custom_tool_call_output` | 与普通函数结果一样接受字符串或纯 `input_text` 数组，保留调用 ID、文本、空白与换行 |
| 显式 `tool_choice` / `allowed_tools` | 按工具类型、名称和可选 `namespace` 解析，并转换为同一上游别名 |

顶层 `tools` 仍需每轮提供。缓存保存恢复后的 Responses 输出项；完整历史、`previous_response_id`、`item_reference` 和 Conversations 均可回传带命名空间的函数调用及 custom 调用/结果。映射仅属于当前请求，不引入跨凭据共享状态。未支持的工具类型仍返回 400，错误包含实际类型。

`custom.format` 接受 `text` 或 `grammar`（`lark` / `regex`）。grammar 定义进入上游工具说明；普通函数转换无法提供原生 grammar 的硬性约束。流式 custom 参数沿用现有参数/输出预算，在完整 JSON 参数校验后一次性发出 `response.custom_tool_call_input.delta` 和 `.done`，事件序号重新连续编号。非法 JSON、缺失/非字符串 input 或多余参数不会产生成功的 custom 调用或完成响应，也不会写入成功历史。嵌套 namespace、组内非 function/custom 工具不支持。

Codex 的 `base_url` 可带或不带 `/v1`。`/responses` 是 `/v1/responses` 的 HTTP JSON/SSE 和 WebSocket 别名；`/chat/completions` 是 `/v1/chat/completions` 的 HTTP JSON/SSE 别名。请求在路由匹配前内部归一化，保留查询参数，不产生重定向；两种路径共用鉴权、校验、预算和缓存，HTTP `previous_response_id` 可跨路径续轮。其他接口仍使用原路径。

验证：`pnpm exec vitest run test/unit/responses-tool-compat.test.ts test/integration/codex-gui-tools.test.ts`。

### Responses 引用缓存

为兼容 Chatbox 1.21.1，Responses 入口在两种上游模式都接受显式 `{type:"item_reference", id:"非空字符串"}`，仅允许这两个字段。网关按输入顺序从本地缓存展开完整输出项，再由 decoder → canonical IR → 所选上游 encoder 处理；不把 `item_reference` 透传给上游，不要求上游能够解析引用。Messages 和 Chat 入口不接受引用，计数路径也不展开引用。

此引用缓存只保存成功 Responses 响应的输出项。JSON 响应和流式响应均须完整校验成功后才写入；失败、截断或未完成的响应不写入。它不缓存请求 prompt、整段历史或 token-count 结果；HTTP `previous_response_id` 和 WS 历史由后两节的独立机制维护。引用缓存不依赖 `store` 参数，也不自动开启上游存储；WS 始终向上游发送 `store:false`。

| 约束 | 行为 |
| --- | --- |
| 隔离 | 每个应用固定一个上游；使用调用凭据的 HMAC 散列及请求 `model` 隔离，不保存 API key 原文 |
| 有效期 | 写入后固定 5 分钟，读取不延长有效期 |
| 单项预算 | 1 MiB |
| 每凭据预算 | 合计 4 MiB、最多 256 项；模型之间共享该凭据预算 |
| 全进程预算 | 合计 32 MiB、最多 2048 项 |
| 超限处理 | 按插入顺序淘汰（FIFO），超出单项预算的内容不缓存；不会因此返回残缺的生成结果 |
| 同 ID 冲突 | 同一隔离范围内出现冲突时，将该引用标记为不可解析；冲突标记同样受原有效期及容量淘汰约束 |
| 清理 | 每 30 秒主动清理过期项，计时器不阻止进程退出；应用关闭时清空缓存 |

字节预算按序列化内容加固定元数据开销估算，是缓存记账上限，不是进程 RSS 硬上限。缓存只存在于当前进程，不写磁盘，不新增环境变量、依赖或持久化设施。

引用未命中、过期、淘汰、重启后失效、跨凭据或跨模型读取，以及同 ID 冲突，均在调用上游前返回 OpenAI 格式 HTTP 400，错误码为 `reference_cache_miss`。不丢弃该历史项，不把未命中引用发给上游，也不回退或重试。

依赖引用的客户端应连接单实例，或在多实例部署中保持粘性路由；不同进程不共享缓存。重启后需要新建会话，或由客户端使用 `store:false` 回传完整历史。完整历史路径不依赖引用缓存。回滚无需数据迁移，但恢复旧版本或重启后不能继续使用旧的内存引用。

### Responses HTTP 历史缓存

`POST /v1/responses` 在两种上游模式中均支持本地 `previous_response_id` 续轮。JSON 和 SSE 共用历史缓存。命中时，按「上一轮完整输入 + 成功输出 + 本轮新增输入」重建请求，展开 `item_reference` 后走原有 decoder/encoder；不向上游传递已经本地解析的 ID。每条历史都是独立的完整快照，祖先过期或被淘汰不会截断仍存活的后代历史。

| 约束 | 行为 |
| --- | --- |
| 隔离 | 每个应用固定一个上游，按凭据 HMAC 散列、请求模型和响应 ID 隔离；不保存 API key 原文 |
| 写入 | 仅完整校验成功且状态为 completed 的响应；失败、取消、截断和 incomplete 不写入 |
| 有效期 | `RESPONSES_HISTORY_TTL_MS`，默认固定 5 分钟；读取或相同内容重复写入不续期 |
| 单条预算 | 序列化完整输入/输出加固定元数据开销，不超过 `BODY_LIMIT_BYTES` |
| 每凭据预算 | `RESPONSES_HISTORY_MAX_CREDENTIAL_BYTES`，默认 32 MiB、最多 128 条，各模型共用 |
| 全进程预算 | `RESPONSES_HISTORY_MAX_BYTES`，默认 128 MiB、最多 1024 条 |
| 淘汰 | FIFO；单条超限跳过缓存，但仍完整返回生成结果；计费和 usage 不变 |
| 冲突 | 同范围同 ID 的不同历史使该 ID 本地不可解析；冲突标记受原有效期及容量限制 |
| 续轮参数 | 仅继承输入/输出；顶层 instructions、工具定义、采样和其他参数每轮提供；input 中的 system/developer 消息属于历史 |
| 分叉/失败 | 可从任意仍有效的父响应分叉；成功或失败续轮不主动淘汰父响应，容量/TTL 淘汰仍生效 |
| store | 保留 HTTP 既有语义，缺省 false，显式 true/false/null 继续转发；本地缓存独立于上游存储，store:false 也缓存 |
| 清理 | 每 30 秒主动清理，读取/写入同样检查过期；计时器不阻止退出，应用关闭清空 |
| 传输边界 | HTTP 和 WS 历史不互通；item_reference 的输出项缓存仍共用 |

Chat 模式本地未命中时，在上游调用前返回 HTTP 400，`error.code=previous_response_not_found`、`error.param=previous_response_id`；不静默丢弃上下文。Responses 模式保留原生续轮兼容：本地未命中时，原样向上游发送 ID 和本轮输入，由上游验证凭据和历史；这类请求的祖先内容未知，因此其响应不会写入本地完整历史缓存。无额外探测或重试。

展开历史后的请求仍受 `BODY_LIMIT_BYTES` 限制，超限返回 HTTP 413 `request_too_large`；引用展开继续使用原有大小限制。省略或设置 `previous_response_id:null` 表示不引用历史。历史缓存不写磁盘、不跨实例共享；重启后本地 ID 失效，多实例需要粘性路由，或由客户端回传完整历史。字节预算是序列化内容和元数据的记账上限，不是进程 RSS 上限。此功能不提供 GET response、删除 response 或后台任务 API；命名会话使用下述独立的 Conversations 接口。

本地验证：`pnpm exec vitest run test/unit/responses-history-cache.test.ts test/integration/responses-previous-response.test.ts`，覆盖 JSON/SSE 交叉续轮、SDK、工具、凭据/模型隔离、容量和过期、分叉、失败及原生上游 ID 透传。

### Conversations 内存会话

Conversations 在网关本地管理，不向上游发送会话管理请求或本地会话 ID。兼容官方 SDK 的以下接口，均使用 Bearer 鉴权；网关验证凭据格式，上游只在生成时验证 API key 有效性。

| 接口 | 行为 |
| --- | --- |
| `POST /v1/conversations` | 创建 `conv_...` 会话，接受可选 `metadata` 和初始 `items` |
| `GET /v1/conversations/:id` | 返回 `id/object/created_at/metadata` |
| `POST /v1/conversations/:id` | 替换指定的 metadata；省略时不修改，null 清空 |
| `DELETE /v1/conversations/:id` | 返回 `conversation.deleted`，同时释放本地历史内存 |
| `POST /v1/conversations/:id/items` | 原子追加最多 20 项，返回新增项列表 |
| `GET /v1/conversations/:id/items` | 默认倒序，支持 `order=asc/desc`、`after` 和 1–100 的 `limit`，默认 20 |
| `GET /v1/conversations/:id/items/:item_id` | 读取单项 |
| `DELETE /v1/conversations/:id/items/:item_id` | 删除单项，返回所属 conversation 对象 |

创建会话也最多携带 20 个初始项；metadata 最多 16 个字符串键值，键不超过 64 字符、值不超过 512 字符。历史项支持本项目 Responses 的文本、图片、推理、函数调用/结果和网页搜索历史子集；管理接口要求完整内容，拒绝未解析的 `item_reference`。未知附加字段忽略。缺省 item ID 和 status 由网关补齐，同一会话不允许重复 ID。列表返回已保存的支持字段，`include` 接受 `reasoning.encrypted_content`、`web_search_call.action.sources` 和 `message.input_image.image_url`，不补充未保存的数据。

生成时传 `conversation:"conv_..."` 或 `conversation:{id:"conv_..."}`；null/省略表示不关联会话。与非 null 的 `previous_response_id` 同时使用返回 400。HTTP JSON/SSE 与 WS `response.create` 共用会话，所有携带 response 对象的事件及 JSON 响应均返回 `conversation:{id}`。网关加载当前历史并添加本轮 input，强制上游 `store:false`；input/output 在完整校验成功且状态为 completed 后一次性写入。上游失败、完成前取消、流损坏和 incomplete 不修改历史；容量错误也不会部分写入。WS `generate:false` 成功后保存输入，空输出不调用上游。顶层 instructions、工具声明、采样配置、请求 metadata 等每轮提供，不保存到会话。

会话按 API key HMAC 隔离，不绑定模型；换模型仍执行目标协议的能力校验。未知、过期、已删除、其他凭据或重启前的 ID 返回 404 `conversation_not_found`，不会隐式新建或透传到上游。默认每凭据 32 MiB/128 个会话，全进程 128 MiB/1024 个会话，字节预算由 `CONVERSATIONS_MAX_CREDENTIAL_BYTES`、`CONVERSATIONS_MAX_BYTES` 配置；每个会话最多 4096 项，序列化数据加元数据开销及展开后的请求另受 `BODY_LIMIT_BYTES` 限制。单会话超限返回 413，凭据/全局容量超限返回 429 `conversation_capacity_exceeded`。容量检查前清理已过期会话，不按 FIFO 淘汰未过期会话或截断历史；过期、删除会话或删除历史项后释放相应预算。这些预算约束存储数据，不代表进程 RSS 上限。

空闲有效期由 `CONVERSATIONS_TTL_MS` 配置，默认 1800000 ms（30 分钟），必须大于 0。使用单调时钟计时，相同凭据读取会话/历史项、修改会话或开始生成时续期；其他凭据的访问不会续期。生成租约存活期间不清理，成功、失败或取消后释放租约时重新获得完整有效期。每 30 秒主动清理过期会话，计时器不阻止进程退出；读写操作同样检查到期，不会因尚未扫描而恢复过期 ID。应用关闭时停止扫描并清空存储。WebSocket ping/pong 不算会话访问。

同一会话生成期间，其他生成、更新、删除或追加操作返回 409 `conversation_busy`；读取可见上次已提交的内容，不同会话互不阻塞。会话只保存在当前进程，重启清空，多实例需要粘性路由。与官方持久化 Conversations 不同，删除本地会话同时释放其历史项；本项目不维护可单独检索的持久化 response 对象。

本地验证：`test/integration/conversations.test.ts`、`test/integration/responses-websocket.test.ts`、`test/unit/conversation-store.test.ts`。

### Responses WebSocket

`GET /v1/responses` 接受 WebSocket Upgrade，握手前验证 Bearer 格式；缺失或格式错误返回 HTTP 401。普通 GET 返回 426。API key 是否被上游接受仍由上游决定。客户端使用 JSON 文本帧发送 `response.create`，服务器每帧返回一个 Responses JSON 事件；不发送 SSE 包装或 `[DONE]`。复用 HTTP 的严格参数解码、引用展开、工具/搜索处理、流校验和输出预算。

| 能力/约束 | 行为 |
| --- | --- |
| 上游传输 | 依据 `UPSTREAM_PROTOCOL` 使用 Chat 或 Responses HTTP/SSE，始终 `store:false`；不连接上游 WS |
| Codex 请求 | `stream` 可省略或为 `true`，兼容生成与 `generate:false` 预热；`client_metadata` 使用上述诊断字段规则 |
| 增量续轮 | `previous_response_id` 在当前连接内、按模型查找成功响应；展开为完整历史后调用上游，不透传 ID |
| 命名会话 | `conversation` 使用进程内共享存储，可跨 HTTP/WS 和 WS 连接续聊；与 `previous_response_id` 互斥 |
| 续轮参数 | 只继承输入/输出上下文；`instructions`、工具定义、采样等生成参数每轮重传 |
| 本地预备 | `generate:false` 返回空输出的成功响应和 ID，供续轮引用，不调用上游，不宣称模型预热 |
| 多路并发 | `stream_id` 为 1–256 个 ASCII 字母、数字、`_`、`-`、`.`；最多 32 个命名流，另有默认流。同名 FIFO，不同名可并发 |
| 事件归属 | 命名流所有事件及请求错误带 `stream_id`，默认流省略；各响应的 `sequence_number` 独立递增 |
| 分叉 | 可从另一流仍缓存的同模型成功响应分叉；分叉开始前来源流若已推进并淘汰父响应，返回 `previous_response_not_found` |
| 历史容量 | 每流仅最新成功响应，全部流合计由 `WEBSOCKET_HISTORY_LIMIT_BYTES` 限制，默认 32 MiB；FIFO 淘汰，单条超限跳过缓存，不截断输出 |
| 失败 | 请求错误不关闭连接；失败/未完成输出不写历史。失败的同流续轮淘汰其父 ID，跨流失败保留来源流父 ID |
| 请求预算 | 单条 wire 消息和展开后的请求受 `BODY_LIMIT_BYTES` 限制；待处理请求的原始消息总大小也受此预算限制，数量受 `WEBSOCKET_MAX_PENDING_REQUESTS` 限制（默认 64，含执行中） |
| 流控 | 等待 WS 写入回调后读取下一上游事件；所有流的待发送字节数上限为 `UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES + UPSTREAM_SSE_FRAME_LIMIT_BYTES`，超限断开并取消上游 |
| 心跳/寿命 | `WEBSOCKET_PING_INTERVAL_MS` 默认 30 秒，下周期未收到 pong 则终止；`WEBSOCKET_MAX_CONNECTION_MS` 默认且最多 60 分钟 |
| 取消/清理 | 断线、到期、心跳失败、服务关闭取消全部上游请求，清空连接历史。单次生成仍遵守上游总超时、首字节与空闲超时 |
| 恢复 | 连接内响应 ID 不跨连接恢复；可回传完整历史，或继续使用同一进程中仍存在的 `conversation` |

错误使用 `{type:"error", status, error:{type, code, message, param?}, stream_id?}`。非法 JSON 为 `invalid_json`；未知事件、非 true 的 `stream`、`background` 字段、非法 `client_metadata` 等无效请求为 `invalid_request`；历史不可用为 `previous_response_not_found`；队列超限为 429 `websocket_queue_full`；流数量超限为 `websocket_stream_limit_reached`；连接到期为 `websocket_connection_limit_reached`。wire 消息过大以 WS 1009 关闭，展开后过大返回 413 `request_too_large`。上游错误继续清洗，不回传私有上游消息、密钥或 prompt。

支持范围是本项目已有 Responses 内容/工具子集的 WebSocket 传输，以及上述续轮和并发功能。仅接受 `response.create`，不实现 Realtime、`response.cancel`、mid-turn steering、inject、服务器 compaction 或后台任务。`generate:false` 只预备输入历史，下一轮仍须提供模型与生成参数。

本地验证：`pnpm exec vitest run test/integration/responses-websocket.test.ts`，测试使用真实本地 WS 握手和消息、可控的上游 HTTP/SSE，不需要真实 API key。

## Web Search discriminator

锁定 SDK 的 exact discriminator：

- Anthropic：`web_search_20250305`、`web_search_20260209`、`web_search_20260318`；
- OpenAI：`web_search`、`web_search_2025_08_26`、`web_search_preview`、`web_search_preview_2025_03_11`。

不使用 prefix matching。Anthropic `response_inclusion` 仅在 `web_search_20260318` 接受 `full | excluded`；OpenAI preview 只接受 preview contract 的 `search_content_types`，stable/versioned 类型使用 `filters.allowed_domains`。

内置 Web Search 由独立 provider registry 执行，当前 provider 为 DuckDuckGo。请求进入 canonical Web Search 后会 materialize 为网关保留的内部 function；上游模型发起该调用时，网关执行搜索、回填结果并继续 completion。Anthropic JSON/SSE 出口会把执行轨迹表示为原生 `server_tool_use` / `web_search_tool_result`，并同步 `usage.server_tool_use.web_search_requests`。网关自身生成的 server-search replay block 在后续 Anthropic 请求中会被识别并过滤，普通名为 `web_search` 的自定义 function 不会被当作内置搜索。

Anthropic `user_location` 的 city、country、region、timezone 字符串进入同一搜索位置配置，空值忽略；位置提示同时提供给模型和搜索执行器，Responses 主路径与 Chat 回退均保留。DuckDuckGo 使用位置作为查询提示，不承诺精确定位或原生地区排序。

### Responses 网关搜索

协议形状参考 [OpenAI Web Search 指南](https://developers.openai.com/api/docs/guides/tools-web-search) 和 [搜索流式事件](https://platform.openai.com/docs/api-reference/responses-streaming/response/web_search_call)。实际检索由 DuckDuckGo Lite 完成，上游仍接收普通内部函数调用；无需上游提供原生搜索能力。

| 输入 | 网关行为 |
| --- | --- |
| `tool_choice:"auto" / "none" / "required"` | 保留模式；完成强制搜索后恢复自动选择，允许模型回答 |
| `tool_choice:{type:"web_search"}` 及对应已声明版本 | 选择内部搜索函数；`{type:"function",name:"web_search"}` 仍选择普通同名函数 |
| `tool_choice:{type:"allowed_tools",mode,tools}` | 校验声明后仅发送允许的工具，模式支持 `auto` / `required`；不保留原始完整工具列表的缓存布局 |
| `include:["web_search_call.action.sources"]` | 在公开搜索项的 `action.sources` 返回去重 URL；未请求则省略，空结果则为 `[]`；不发送给上游 |
| `include:["reasoning.encrypted_content"]` | 继续发给上游，可与搜索来源请求同时使用；其他 include 值返回 400 |
| `max_tool_calls` | 正整数，限制本次请求的搜索执行次数；达到上限后移除内部搜索工具。仍受既有最多 8 轮模型调用限制 |
| `search_context_size` | `low` / `medium` / `high` 对应最多 3 / 5 / 10 条结果；默认 5 条。不模拟原生 token 预算 |
| stable `filters.allowed_domains` / `filters.blocked_domains` | 每个列表最多 100 个无协议和路径的域名，匹配域名及其子域名；中文域名通过 IDNA 与 Punycode 统一匹配；在已检索结果上过滤 |
| `user_location.city / region / country` | 作为搜索词的位置提示，并提供给模型；不承诺精确地理定位或原生地区排序 |
| `user_location.timezone` | 作为模型生成查询时的提示；不会转换为 DuckDuckGo 时区过滤 |
| `external_web_access:true` 或省略 | 在线检索；`false` 返回 400，网关没有离线搜索缓存 |
| preview `search_content_types` | 支持文本；包含 `image` 返回 400，不执行图片搜索 |

每次执行在 JSON 中生成独立的 `web_search_call`，包含稳定的网关调用 ID、`status:"completed"`、`action.type:"search"`、`query` 和 `queries`。JSON 搜索记录位于最终模型输出之前；流式则保留实时可见顺序。SSE 生命周期为 `response.output_item.added` → `response.web_search_call.in_progress` → `response.web_search_call.searching` → `response.web_search_call.completed` → `response.output_item.done`，最终响应的搜索项与已发送的完成事件一致。普通文本无需等待搜索轮次全部结束。

来源与引用分别处理：来源列出实际搜索结果，`url_citation` 仅添加到答案里实际出现的匹配 URL 或 Markdown 链接；未引用的来源不生成注解，已有上游引用保留且不重复添加。流式链接可以跨 delta，到文本结束时生成完整引用。新增搜索项、来源及引用复用输出限额；各模型轮次的 usage 继续累计。

完整历史多轮支持把 JSON 或 SSE 终态的 `output` 回传到 `input`；本地引用或 previous_response_id 命中后也进入同一历史解码路径。合法 `web_search_call` 的搜索、打开页面和页内查找记录会转为历史文本，保留动作、状态、查询及可用 URL；不重新搜索，不把网关生成的调用 ID 发给上游。仅支持历史动作回传，不新增实时打开页面或页内查找能力。此路径不会重建未回传且未命中缓存的摘要，不提供持久化搜索会话；需要不受缓存有效期限制的搜索上下文时应回传完整历史输出。

既有 DuckDuckGo 降级行为保持不变：请求失败、限流或无结果均作为空结果回填，`completed` 表示搜索尝试结束，不保证结果非空；调用方取消则终止请求。上游在同一轮混合内部搜索和需要客户端执行的函数仍会拒绝，防止缺少函数结果时继续调用模型。

兼容性收紧：同一请求只接受一个内置搜索声明，函数不能占用 `__ai_hub_web_search` 保留名称，显式工具选择必须指向已声明工具。此前重复搜索声明会产生相同内部函数，离线和图片参数可能被忽略；现在返回明确的 400。迁移时保留一个搜索版本、移除无法实现的参数并选择文本在线检索，无配置或数据迁移。

本地复现（不依赖网络服务）：

```powershell
node node_modules/vitest/vitest.mjs run test/unit/responses-web-search.test.ts test/integration/responses-web-search.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

集成测试注入固定 DuckDuckGo HTML 和上游模型响应，验证实际 provider 解析、HTTP JSON/SSE、参数映射、引用、回传与取消。真实搜索可用性仍取决于运行环境访问 DuckDuckGo 的能力。

## Chat 对外入口

Chat 请求也经过独立 decoder → canonical IR → encoder，直接发送到固定的上游 `/chat/completions` 路径。Bearer 凭据、模型和已支持的语义保持一致，不透传任意请求体。

WorkBuddy 会给消息附加 `agent`（例如 `"cli"`）。Chat 入口接受 `messages[].agent` 为字符串或 `null`，校验后丢弃，不写入 canonical 内容、上游请求、消息 `name` 或缓存键。该兼容规则适用于普通消息、助手工具调用历史和工具结果；其他未知字段直接忽略，非法 `agent` 类型仍返回 HTTP 400。

| 能力 | 行为 |
| --- | --- |
| 消息 | 支持 system/developer/user/assistant/tool；保留 developer、消息 name、文本、URL/data URL 图片及 detail |
| 函数工具 | 支持工具定义、strict 缺省/null/false/true、调用及结果、tool_choice、parallel_tool_calls；网关保留的内部工具名称不可由客户端声明 |
| reasoning/refusal | 支持 reasoning_content 与独立 refusal 字段，JSON/SSE 保持语义；Chat 同协议保留原始 finish_reason |
| 输出格式 | 支持 text、json_object、json_schema；保留 schema 名称、description 和 strict |
| 输出长度 | 支持 max_tokens 或 max_completion_tokens，两者同时提供返回 400 |
| 采样及同协议选项 | 支持 temperature、top_p、stop、frequency_penalty、presence_penalty、seed、logit_bias、reasoning_effort、user、safety_identifier、service_tier、metadata、store；白名单字段按类型校验 |
| 候选数及不支持字段 | 仅支持 n=1；n>1、音频、logprobs、旧式 functions/function_call、内置搜索返回 400；未知附加字段直接忽略 |
| 工具参数字符串 | Chat 直连保留上游字符串，包含被 length 截断的非完整 JSON；客户端负责解析和执行。Messages 回退维持既有严格参数校验 |
| 流式输出 | 实时 data chunk，正常结束输出原始 `[DONE]`；仅客户端指定 include_usage=true 时发送最终 usage chunk，缓存统计只保留上游已报告字段 |
| 错误和生命周期 | 首次输出前返回 OpenAI HTTP 错误，输出后发送清洗后的 error 并关闭，不发送成功终止标记；超时、断连、输出限额和优雅关闭复用现有机制 |

Chat 入口不执行内置 Web Search；名为 `web_search` 的普通函数工具交由客户端执行。

### CCS 思考参数兼容

CC Switch 的本地路由可将 Codex Responses 请求转换为 Chat，并按供应商配置添加思考参数。Chat 入口接受以下扩展，通过既有同协议扩展保存和编码机制原样发送给 Chat 上游：

| 字段 | 接受的结构及取值 |
| --- | --- |
| `thinking` | 仅包含 `type` 的对象，值为 `enabled` 或 `disabled` |
| `enable_thinking` | 布尔值 |
| `reasoning_split` | 布尔值 |
| `reasoning` | 仅包含 `effort` 的对象，值为 `none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

这些扩展的缺省状态及显式关闭值原样保留；不自动添加另一种思考参数，不转换为 canonical `reasoningEffort`，也不回放到 Responses 或其他来源的请求中。原有 `reasoning_effort` 的取值和跨协议行为不变。已知扩展参数中的 `null`、非法类型或未知取值在调用上游前返回 HTTP 400，错误不包含请求值；未知附加字段直接忽略，包括 `thinking` 和 `reasoning` 的额外字段。

网关只保证字段传递，不保证目标模型支持对应参数或关闭思考。具体模型能力由上游判断；不根据模型名称自动改写。默认 Chat 模式下 `/v1/responses` 可直接转换到 Chat 上游；上述 CCS 特有开关仍仅接受于 Chat 入口，Responses 使用 `reasoning.effort`，不会自动补充供应商特有开关。

参数依据：[CC Switch 转换实现](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/proxy/providers/transform_codex_chat.rs)、[智谱思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[OpenRouter reasoning 参数](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。本节仅覆盖 CCS 所用的上述结构，不声明支持供应商的完整扩展 API。

本地回归覆盖 JSON/SSE 上游请求、工具结果续轮、思考开启与关闭、非法参数拒绝和跨协议隔离：

```powershell
pnpm exec vitest run test/unit/chat-request.test.ts test/integration/chat-sdk.test.ts
```

## Prompt cache

Anthropic `cache_control` 只进入 request-local positional sidecar，不进入 canonical IR extension bag。只有恰好落在 canonical tool/system/message 节点末端的 marker 才能保存；非终端、同节点重复、malformed、unsupported block marker 返回固定安全错误。

Responses 和 Chat 默认 capability 为 `prompt-cache-key`，三个生成入口默认发送提示词缓存键，不增加配置。调用方字符串原样使用；显式 null 保留并抑制自动生成。Messages 的 prompt_cache_key 是网关扩展，仅校验该字段，不跨协议回放其他私有扩展。

自动键取版本标识、目标接口、模型、实际编码后的工具定义和开头连续的 system/developer 消息的 SHA-256；保留工具、消息、内容的原有顺序。没有工具和系统前缀时不生成。后续对话、采样参数和流式选项不参与生成。搜索续轮保留初始键，回退时按目标接口重新生成自动键。显式键和 null 在所有轮次及回退中保持不变。

Claude Code 断点规划仍要求有效版本且开关启用，最多四个断点。该开关不控制默认缓存键。当前不会编码 Anthropic cache_control、TTL 或假想的等价断点。`planned`、`encoded` 与 provider usage 报告的 hit/write 是不同状态。

`count_tokens` 不规划或发送缓存控制字段。提示词缓存键不保证命中，不估算命中或写入 token。Responses 输出项的短期引用缓存独立于上游提示词缓存，不复用答案来代替生成请求，也不影响缓存键生成或 usage。上游需支持 prompt_cache_key；如果上游拒绝该字段，不进行删字段重试。此次默认行为变化无需数据库迁移，回滚通过恢复上一版本完成。

## Reasoning 与 signature

- Anthropic `output_config.effort` 的 `low | medium | high | xhigh | max | null` 进入 canonical 请求：Responses 与 `responses/input_tokens` 编码为 `reasoning.effort`，Chat fallback 编码为 `reasoning_effort`；字段缺失时不发送。网关不预判目标模型支持的等级，也不从旧 `thinking.budget_tokens` 推断 effort。
- Anthropic `thinking` 的 enabled/disabled/adaptive、budget_tokens 和 display 当前只校验并保留为来源扩展，不映射到上游开关或显示控制；需要控制上游推理强度时使用 `output_config.effort`。`redacted_thinking` 历史块暂不支持，返回 400。
- Anthropic `output_config.format` 接受 `null` 或 `{ type: "json_schema", schema: {...} }`。非 null 时 schema 进入 canonical structured-output 配置：Responses 与 `responses/input_tokens` 编码到 `text.format`，Chat fallback 编码到 `response_format.json_schema`。未知的 `output_config` 子字段和额外 format 字段直接忽略；未知 format 类型或非 JSON object schema 返回 Anthropic HTTP 400。
- Anthropic 历史真实 signature 原样作为 opaque compatibility data 处理；缺失或空 signature 可由普通 Anthropic 客户端回传，不会导致请求被拒绝。
- Claude Code synthetic signature 是 UUID v4 文本的标准 Base64，不是 provider continuation。
- synthetic signature 不会写入 OpenAI `encrypted_content`。
- Anthropic thinking 没有 Responses reasoning item `id` 或 provider continuation，因此在 Anthropic → Responses 历史编码中省略；assistant text、function call 与匹配的 function result 仍按原顺序发送。Chat fallback 继续使用已识别的 `reasoning_content` 扩展。
- Responses 的真实 reasoning item `id` 和 `encrypted_content` 只允许同协议、kind=`reasoning`、非 synthetic continuation 回放；SSE 的 `encrypted_content` 在 `response.output_item.done` 提取。
- Responses `output_item.done` 的 item identity、完整正文/参数和 URL annotation 顺序必须与 added + delta 状态一致；校验使用固定大小 hash，不额外无界缓存正文。
- Responses `content_part.added/done` 作为辅助快照忽略，兼容重复、字段缺省和预填正文或引用；不重复累加内容，也不以此提前关闭内容块。正文和引用由 `output_item.added` 与实际增量累计，在 `output_item.done` 核对。没有拒答增量时，允许在最终输出项中一次性返回完整拒答；只有实际保留的内容块状态计入输出预算，索引可以跳过没有增量的空块。
- 同一 Responses 消息的多个文本块按顺序合并；每个内容块独立校验引用序号，输出引用位置按前置文本长度偏移，块状态计入输出预算。后续块开始输出文本后不能再向前置块追加文本，以保持已经输出的引用位置有效；前置块的延迟引用仍可处理。`output_item.done` 保留上游的输出项状态。
- Responses 同协议 SSE 允许状态为 `incomplete` 的客户端函数保留截断参数并正常返回未完成终态；成功工具调用、网关内部搜索工具和 Anthropic 出口继续要求完整 JSON 对象。未完成响应不进入引用缓存。
- 已关闭的 Responses output index 与 Anthropic content block index 不可复用。

## 流与错误

- Anthropic SSE 顺序：`message_start → content block events → message_delta → message_stop`。
- Anthropic 原有的命名 `event: ping` 保留，通过 `ANTHROPIC_PING_INTERVAL_MS` 配置；它不算真实数据，不重置新增注释心跳的空闲计时。
- 仅 `stream:true` 的 Anthropic / Responses / Chat 请求启用注释心跳 `: ping\n\n`，新增心跳不使用 `data:` 或 `event:`。从等待上游开始计时，每连续 15 秒没有下游真实数据时发送一次；真实数据输出会重置计时。通过 `SSE_HEARTBEAT_INTERVAL_MS` 调整或设为 `0` 禁用。上游心跳被解析器消费后，网关独立维持下游连接；断开、结束或报错时清理定时器。心跳不改变任何上游超时预算，非流式响应行为不变。
- 首次数据或心跳会立即刷新 SSE 响应头，设置 `Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`，随后直接写入响应流。
- 心跳由发送器统一管理，数据写入等待 `drain` 或响应存在背压时跳过心跳，恢复可写后继续。请求取消立即停止心跳；若有阻塞写入则销毁连接并释放等待者，使请求总超时和服务关闭能完成清理。连接仍可写时保留入口协议的流内错误；已取消请求的错误帧若也产生背压，则直接关闭连接，不再等待 `drain`。
- Responses SSE 重新生成单调 `sequence_number`，终态后发送 `[DONE]`。
- Chat 工具调用的后续增量允许 `id`、`type`、`function.name` 为 `null`，或省略 / 置空 `function`；这些表示没有新元数据，沿用已建立的调用信息。首个分片仍须提供调用 ID 和函数名，非空身份变化和非法字段类型仍会报错，各入口的参数完整性与预算校验保持原有规则。该兼容形状与 [vLLM 的可空 DeltaToolCall / DeltaFunctionCall 字段](https://docs.vllm.ai/en/v0.11.0/api/vllm/entrypoints/openai/protocol.html#vllm.entrypoints.openai.protocol.DeltaToolCall)一致。
- Web Search 的各轮模型调用保持真实 SSE；普通输出实时转发，内部 function 不暴露给客户端。Anthropic 在搜索等待期间持续发送 ping，并在搜索结果到达时输出对应的原生搜索块。
- 模型轮次、搜索执行和受限回退共享请求总超时；最终 token/cache usage 累计所有轮次，后续轮次的 HTTP 错误不能触发 Chat 回退。
- `CONNECTION_TIMEOUT_MS=0` 默认禁用 socket 空闲超时，避免在上游总超时或 SSE 首字节/idle 超时之前截断有效请求。
- 首次数据或心跳前的错误返回入口协议的 HTTP JSON；提交 SSE 响应头之后（包括首条心跳之后）的错误返回入口协议的流内 error。
- 四条 POST route 使用保留未知字段、禁止类型强转的浅层 wire schema；adapter 提取已支持的字段，默认忽略顶层及嵌套协议对象中的未知附加字段，不向上游转发。Responses WebSocket 采用相同规则，HTTP/WS 续轮历史也不保留这些未知字段。工具参数、JSON Schema、metadata 和文本中的业务数据不按协议字段过滤。无需配置开关。
- 已知字段继续做类型、取值和语义校验；不支持的消息角色、内容类型、工具类型及明确不支持的功能仍拒绝。schema 与 malformed JSON 返回入口协议的固定 HTTP 400，body 超限返回固定 HTTP 413。
- 单帧 SSE、成功 JSON body、错误外壳 body、单输出项/保留状态、整条流输出/状态、工具参数、请求 body、首字节等待、流 idle 与请求总时长都有上限；malformed upstream SSE UTF-8 fail-closed。
- 请求关闭、响应连接关闭、SSE reply 关闭和 graceful shutdown 均传播 AbortSignal 并取消上游 body。

## 已知有损语义

- canonical `incomplete` 映射 Anthropic `pause_turn`；`max_output_tokens` 映射 `max_tokens`。
- OpenAI `content_filter` 与上游 refusal 映射为 canonical `refusal`；Anthropic 出口将 refusal 折为 text 块并输出 `stop_reason:"refusal"`，Responses 流式透传中折叠为 text delta（非流式保留原生 refusal part）。
- Anthropic `tool_result` 中的 image/search_result 内容无法映射到 Responses `function_call_output` 或 Chat tool 消息，请求在调用上游前返回 HTTP 400，且不触发 Chat 回退。
- Anthropic `stop_sequences` 仅 Chat fallback 可表达（`stop`）；发往 Responses 上游时被丢弃。Anthropic `top_k` 在两条上游路径都无可表达字段，不转发。
- Anthropic citation 不伪造 encrypted index；仅保留可表达的 URL、title 与文本区间。
- Chat-compatible upstream 的 reasoning、citation 和 usage 扩展并非统一标准，只有已识别字段进入 canonical 表示。
- 默认 prompt_cache_key 只辅助上游前缀缓存，不声明 Anthropic breakpoint 或 TTL 的等价关系。

2026-09-11 的字段保留修复无需数据迁移。Responses 客户端若依赖非严格函数调用，应显式发送 `strict:false`，不再依赖网关将缺省改写成 false。Anthropic 工具失败的原始文本保存在结果 JSON 的 `output` 中。回滚可恢复上一版本；进程重启会清空既有短期引用缓存。相关本地回归：

```powershell
pnpm exec vitest run test/unit/protocol-request-gaps.test.ts test/unit/responses-stream-gaps.test.ts test/integration/protocol-conversion-gaps.test.ts test/integration/protocol-stream-gaps.test.ts
pnpm exec vitest run test/integration/claude-code-stream-compatibility.test.ts
```
