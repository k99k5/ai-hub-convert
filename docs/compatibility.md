# 兼容性契约

## Public APIs

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `GET /health/live`
- `GET /health/ready`

网关不持久化凭据、prompt、会话、conversation、response 或 token-count 结果。唯一的跨请求内存状态是用于 Responses 引用续轮的短期输出项缓存；不缓存请求 prompt、整段历史或 API key 原文。

## 路由与回退

| 入口 | 默认上游 | Chat 回退 |
| --- | --- | --- |
| Anthropic Messages JSON/SSE | Responses | 仅在明确 endpoint 不存在且零语义事件、零客户端写入时允许 |
| Anthropic count_tokens | Responses input_tokens | 永不回退 |
| OpenAI Responses JSON/SSE | Responses | 永不回退 |
| OpenAI Chat Completions JSON/SSE | Chat Completions | 直接请求，不回退或重试 |

明确 endpoint 不存在仅包括 HTTP 405、501，或携带 `route_not_found`、`endpoint_not_found`、`unsupported_endpoint`、`not_implemented` 的 HTTP 404。认证、限流、服务端错误、timeout/disconnect、model missing、模糊 404、HTTP 200 后 malformed SSE 都不会触发回退。

## 内容矩阵

| 能力 | Anthropic → Responses | Anthropic → Chat fallback | Responses → Responses |
| --- | --- | --- | --- |
| text / system | 支持 | 支持 | 支持 |
| URL image | 支持 | 支持 | 支持 |
| Base64 image | 支持 | 支持 | 支持 |
| function tools | 支持 | 支持 | 支持 |
| tool calls/results | 支持；`tool_result` 中的 image/search_result 内容返回 HTTP 400 | 同上；不触发 Chat 回退 | 支持；`function_call_output.output` 接受字符串或纯 `input_text` 数组，图片和文件结果返回 HTTP 400 |
| parallel/interleaved calls | 支持 | 支持 | 支持 |
| reasoning/thinking | Anthropic thinking 可返回客户端；历史 thinking 不伪造成 Responses reasoning continuation | 支持常见 Chat reasoning 扩展 | 支持；真实 item `id` 与 `encrypted_content` 只作同协议 continuation |
| `output_config.effort` | `reasoning.effort` | `reasoning_effort` | 不适用；完整 `reasoning` 对象同协议回放 |
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

### Responses 引用缓存

为兼容 Chatbox 1.21.1，Responses → Responses 接受显式 `{type:"item_reference", id:"非空字符串"}`，仅允许这两个字段。网关按输入顺序从本地缓存展开完整输出项，再由既有 decoder → canonical IR → encoder 处理；不把 `item_reference` 透传给上游，不要求上游能够解析引用。引用不跨协议转换，也不进入计数路径。

只缓存成功 Responses 响应的输出项。JSON 响应和 SSE 流均须完整校验成功后才写入；失败、截断或未完成的响应不写入。不缓存请求 prompt、整段历史或 token-count 结果，不提供 `previous_response_id` 会话重建。网关默认 `store:false`；调用方显式 `store:true | false | null` 保持原值，引用缓存不依赖该参数，也不自动开启上游存储。

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

完整历史多轮支持把 JSON 或 SSE 终态的 `output` 回传到 `input`；本地引用命中后也进入同一历史解码路径。合法 `web_search_call` 的搜索、打开页面和页内查找记录会转为历史文本，保留动作、状态、查询及可用 URL；不重新搜索，不把网关生成的调用 ID 发给上游。仅支持历史动作回传，不新增实时打开页面或页内查找能力。此路径不会重建未回传且未命中缓存的摘要，也不把 `previous_response_id` 变成网关搜索会话存储；需要不受缓存有效期限制的搜索上下文时应回传完整历史输出。

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

| 能力 | 行为 |
| --- | --- |
| 消息 | 支持 system/developer/user/assistant/tool；保留 developer、消息 name、文本、URL/data URL 图片及 detail |
| 函数工具 | 支持工具定义、strict 缺省/null/false/true、调用及结果、tool_choice、parallel_tool_calls；网关保留的内部工具名称不可由客户端声明 |
| reasoning/refusal | 支持 reasoning_content 与独立 refusal 字段，JSON/SSE 保持语义；Chat 同协议保留原始 finish_reason |
| 输出格式 | 支持 text、json_object、json_schema；保留 schema 名称、description 和 strict |
| 输出长度 | 支持 max_tokens 或 max_completion_tokens，两者同时提供返回 400 |
| 采样及同协议选项 | 支持 temperature、top_p、stop、frequency_penalty、presence_penalty、seed、logit_bias、reasoning_effort、user、safety_identifier、service_tier、metadata、store；白名单字段按类型校验 |
| 候选数及不支持字段 | 仅支持 n=1；n>1、音频、logprobs、旧式 functions/function_call、内置搜索及其他未知字段返回 400 |
| 工具参数字符串 | Chat 直连保留上游字符串，包含被 length 截断的非完整 JSON；客户端负责解析和执行。Messages 回退维持既有严格参数校验 |
| 流式输出 | 实时 data chunk，正常结束输出原始 `[DONE]`；仅客户端指定 include_usage=true 时发送最终 usage chunk，缓存统计只保留上游已报告字段 |
| 错误和生命周期 | 首次输出前返回 OpenAI HTTP 错误，输出后发送清洗后的 error 并关闭，不发送成功终止标记；超时、断连、输出限额和优雅关闭复用现有机制 |

Chat 入口不执行内置 Web Search；名为 `web_search` 的普通函数工具交由客户端执行。

## Prompt cache

Anthropic `cache_control` 只进入 request-local positional sidecar，不进入 canonical IR extension bag。只有恰好落在 canonical tool/system/message 节点末端的 marker 才能保存；非终端、同节点重复、malformed、unsupported block marker 返回固定安全错误。

Responses 和 Chat 默认 capability 为 `prompt-cache-key`，三个生成入口默认发送提示词缓存键，不增加配置。调用方字符串原样使用；显式 null 保留并抑制自动生成。Messages 的 prompt_cache_key 是网关扩展，仅校验该字段，不跨协议回放其他私有扩展。

自动键取版本标识、目标接口、模型、实际编码后的工具定义和开头连续的 system/developer 消息的 SHA-256；保留工具、消息、内容的原有顺序。没有工具和系统前缀时不生成。后续对话、采样参数和流式选项不参与生成。搜索续轮保留初始键，回退时按目标接口重新生成自动键。显式键和 null 在所有轮次及回退中保持不变。

Claude Code 断点规划仍要求有效版本且开关启用，最多四个断点。该开关不控制默认缓存键。当前不会编码 Anthropic cache_control、TTL 或假想的等价断点。`planned`、`encoded` 与 provider usage 报告的 hit/write 是不同状态。

`count_tokens` 不规划或发送缓存控制字段。提示词缓存键不保证命中，不估算命中或写入 token。Responses 输出项的短期引用缓存独立于上游提示词缓存，不复用答案来代替生成请求，也不影响缓存键生成或 usage。上游需支持 prompt_cache_key；如果上游拒绝该字段，不进行删字段重试。此次默认行为变化无需数据库迁移，回滚通过恢复上一版本完成。

## Reasoning 与 signature

- Anthropic `output_config.effort` 的 `low | medium | high | xhigh | max | null` 进入 canonical 请求：Responses 与 `responses/input_tokens` 编码为 `reasoning.effort`，Chat fallback 编码为 `reasoning_effort`；字段缺失时不发送。网关不预判目标模型支持的等级，也不从旧 `thinking.budget_tokens` 推断 effort。
- Anthropic `thinking` 的 enabled/disabled/adaptive、budget_tokens 和 display 当前只校验并保留为来源扩展，不映射到上游开关或显示控制；需要控制上游推理强度时使用 `output_config.effort`。`redacted_thinking` 历史块暂不支持，返回 400。
- Anthropic `output_config.format` 接受 `null` 或 `{ type: "json_schema", schema: {...} }`。非 null 时 schema 进入 canonical structured-output 配置：Responses 与 `responses/input_tokens` 编码到 `text.format`，Chat fallback 编码到 `response_format.json_schema`。未知的 `output_config` 子字段、未知 format 类型、额外 format 字段或非 JSON object schema 都 fail-closed，返回 Anthropic HTTP 400。
- Anthropic 历史真实 signature 原样作为 opaque compatibility data 处理；缺失或空 signature 可由普通 Anthropic 客户端回传，不会导致请求被拒绝。
- Claude Code synthetic signature 是 UUID v4 文本的标准 Base64，不是 provider continuation。
- synthetic signature 不会写入 OpenAI `encrypted_content`。
- Anthropic thinking 没有 Responses reasoning item `id` 或 provider continuation，因此在 Anthropic → Responses 历史编码中省略；assistant text、function call 与匹配的 function result 仍按原顺序发送。Chat fallback 继续使用已识别的 `reasoning_content` 扩展。
- Responses 的真实 reasoning item `id` 和 `encrypted_content` 只允许同协议、kind=`reasoning`、非 synthetic continuation 回放；SSE 的 `encrypted_content` 在 `response.output_item.done` 提取。
- Responses `output_item.done` 的 item identity、完整正文/参数和 URL annotation 顺序必须与 added + delta 状态一致；校验使用固定大小 hash，不额外无界缓存正文。
- 同一 Responses 消息的多个文本块按顺序合并；每个内容块独立校验引用序号，输出引用位置按前置文本长度偏移，块状态计入输出预算。后续块开始输出文本后不能再向前置块追加文本，以保持已经输出的引用位置有效；前置块的延迟引用仍可处理。`output_item.done` 保留上游的输出项状态。
- Responses 同协议 SSE 允许状态为 `incomplete` 的客户端函数保留截断参数并正常返回未完成终态；成功工具调用、网关内部搜索工具和 Anthropic 出口继续要求完整 JSON 对象。未完成响应不进入引用缓存。
- 已关闭的 Responses output index 与 Anthropic content block index 不可复用。

## 流与错误

- Anthropic SSE 顺序：`message_start → content block events → message_delta → message_stop`。
- Anthropic keepalive 使用命名 `event: ping`。
- Responses SSE 重新生成单调 `sequence_number`，终态后发送 `[DONE]`。
- Web Search 的各轮模型调用保持真实 SSE；普通输出实时转发，内部 function 不暴露给客户端。Anthropic 在搜索等待期间持续发送 ping，并在搜索结果到达时输出对应的原生搜索块。
- 模型轮次、搜索执行和受限回退共享请求总超时；最终 token/cache usage 累计所有轮次，后续轮次的 HTTP 错误不能触发 Chat 回退。
- `CONNECTION_TIMEOUT_MS=0` 默认禁用 socket 空闲超时，避免在上游总超时或 SSE 首字节/idle 超时之前截断有效请求。
- 首帧前错误返回入口协议的 HTTP JSON；首帧后错误返回入口协议的流内 error。
- 四条 POST route 使用保留未知字段、禁止类型强转的浅层 wire schema；adapter 继续负责精确语义校验。schema 与 malformed JSON 返回入口协议的固定 HTTP 400，body 超限返回固定 HTTP 413。
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
```
