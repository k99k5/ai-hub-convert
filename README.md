# LLM Protocol Gateway

一个不持久化数据的 OpenAI / Anthropic 协议转换网关。服务使用 TypeScript ESM、Fastify 5 和 Node.js 24，对外提供 Anthropic Messages、Anthropic token counting、OpenAI Responses 与 Chat Completions 接口；不使用数据库。Responses 支持 HTTP JSON/SSE 和 WebSocket。HTTP 的 `previous_response_id` 续轮使用有容量上限的短期输入/输出历史缓存，`item_reference` 使用独立的输出项缓存，均按调用凭据和请求模型隔离；WebSocket 历史仅在连接内保留，断线即清理。凭据、prompt 和会话均不写磁盘。

## 路由

| 对外接口 | 上游接口 | 行为 |
| --- | --- | --- |
| `POST /v1/messages` | `/v1/chat/completions` | 默认强制 Chat，转换回 Anthropic JSON/SSE，不探测 Responses、不回退 |
| `POST /v1/messages/count_tokens` | 无 | 默认 Chat 模式返回 501；不通过生成请求或本地估算计数 |
| `POST /v1/responses` | `/v1/chat/completions` | 默认强制 Chat，转换回 Responses JSON/SSE；支持工具、`previous_response_id`、引用续轮和缓存统计 |
| `GET /v1/responses`（WebSocket Upgrade） | `/v1/chat/completions` | 默认走 Chat HTTP/SSE，输出 Responses WS 事件；支持连接内增量续轮和并行流 |
| `POST /v1/chat/completions` | `/v1/chat/completions` | 完整 decode → canonical IR → encode；直接请求 Chat，不回退或重试 |
| `GET /v1/usage` | `/v1/usage` | 透传用量查询；字段含义由上游定义 |
| `GET /v1/models` | `/v1/models` | 透传模型列表查询 |
| `GET /health/live` | 无 | 进程存活检查 |
| `GET /health/ready` | 无 | 就绪检查 |

默认 `UPSTREAM_PROTOCOL=chat`，所有生成入口只请求上游 Chat，不需要上游提供 Responses。`prompt_cache_key` 随 Chat 请求发送，可避免 sub2api 等中间层在 Responses → Chat 转换时漏传缓存键。网关内置搜索会继续调用 Chat 完成工具续轮。

显式设置 `UPSTREAM_PROTOCOL=responses` 可恢复原路由：Messages 优先 Responses，Responses 入口只请求 Responses，计数委托 `/responses/input_tokens`；Chat 入口仍走 Chat。在此模式下，`/v1/messages` 只在尚无上游语义事件、尚未向客户端写入 SSE 字节，并且 Responses 返回以下明确 endpoint 缺失信号时回退：

- HTTP 405 或 501；
- HTTP 404 且错误码为 `route_not_found`、`endpoint_not_found`、`unsupported_endpoint` 或 `not_implemented`。

401、403、429、5xx、timeout、disconnect、`model_not_found`、模糊 404、HTTP 200 后 malformed SSE，以及任何已产生语义事件或客户端写入后的错误都不会触发回退。SDK 自动重试被禁用，每个 adapter attempt 最多调用一次上游。

## 快速开始

要求：

- Node.js 24；
- pnpm 10.6.3；
- 一个支持 Chat Completions 的 OpenAI-compatible 上游；生成接口需接受 `prompt_cache_key`。只有显式选择 Responses 模式才需要上游支持 Responses。

```bash
pnpm install --frozen-lockfile --ignore-scripts
cp .env.example .env
pnpm dev
```

最小配置：

```dotenv
UPSTREAM_BASE_URL=https://gateway.example.com/v1
```

调用方凭据按入口协议读取并转成上游 Bearer：Anthropic 接受 `x-api-key`，并兼容 Bearer；Responses 和 Chat 接受 Bearer。`model` 原样透传。Anthropic SDK 或 Chatbox 的 Anthropic 模式 base URL 应填写 `http://127.0.0.1:3000`，不要追加 `/v1`；SDK 会自行请求 `/v1/messages`。OpenAI SDK 的 base URL 填写 `http://127.0.0.1:3000/v1`。这与上游地址 `UPSTREAM_BASE_URL` 是两个不同配置。

Anthropic 示例：

```bash
curl http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: YOUR_UPSTREAM_KEY' \
  -d '{"model":"vendor/model","max_tokens":256,"messages":[{"role":"user","content":"hello"}]}'
```

Responses 示例：

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_UPSTREAM_KEY' \
  -d '{"model":"vendor/model","input":"hello"}'
```

Chat 示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_UPSTREAM_KEY' \
  -d '{"model":"vendor/model","messages":[{"role":"system","content":"请用中文回答。"},{"role":"user","content":"hello"}]}'
```

三个生成入口都支持 `stream:true`。Chat 使用标准 `data:` chunk 和 `[DONE]`；只有请求 `stream_options:{"include_usage":true}` 时才输出最终 usage chunk。四条 POST route 先做不改写 body 的浅层 wire schema 校验，再由 adapter 做精确语义校验；错误分别使用入口协议的固定 HTTP 400 外壳。超过 `BODY_LIMIT_BYTES` 时返回固定 HTTP 413，且不会回传 validation path 或请求内容。

Responses 与 Chat 在首个下游事件发出后，默认每 15 秒发送 SSE 注释心跳 `: heartbeat`，用于维持思考、工具等待或上游仅发送心跳期间的连接；客户端应忽略注释。心跳间隔可用 `SSE_HEARTBEAT_INTERVAL_MS` 调整，应小于反向代理的空闲超时。心跳不延长上游首字节、空闲或请求总超时。

下游写入阻塞时暂停心跳，恢复可写后继续；请求取消、响应结束或连接关闭时停止心跳。总超时或服务关闭会解除阻塞的写入并关闭连接；连接仍可写时，按入口协议发送流内错误。

## 用量与模型查询

`GET /v1/usage` 和 `GET /v1/models` 接受 Bearer 或 `x-api-key`，统一转成上游 Bearer。查询参数、上游状态码和响应正文原样返回；额度单位、重置时间及模型列表以当前上游为准。完整行为见[读取接口透传契约](docs/compatibility.md#读取接口透传)。

```bash
curl 'http://127.0.0.1:3000/v1/usage' -H 'authorization: Bearer YOUR_UPSTREAM_KEY'
curl 'http://127.0.0.1:3000/v1/models' -H 'authorization: Bearer YOUR_UPSTREAM_KEY'
```

## 默认提示词缓存

生成请求默认使用 `prompt_cache_key`，不需要增加配置。三个入口都接受字符串键并原样发送；显式 `null` 禁止自动生成。Anthropic Messages 中的这个字段是网关扩展。

未提供键时，网关根据版本标识、目标接口、模型、编码后的工具定义及开头连续的 system/developer 消息生成 SHA-256 键。追加对话、切换 JSON/SSE 或调整采样不会改变键；没有工具或系统前缀时不生成。搜索续轮沿用初始键，Messages 回退 Chat 时按目标接口重算自动键。

缓存键仅辅助上游复用提示词前缀，不保证命中。缓存命中和写入 token 数仅使用上游 usage；不会从断点规划推算。`count_tokens` 不发送缓存控制字段。要求上游支持 `prompt_cache_key`，不兼容时不会通过删除字段重试。下面的 Responses 引用缓存独立于提示词缓存，不影响缓存键或 usage。

## Responses 引用续轮

Chatbox 1.21.1 回传的 `item_reference` 在网关内展开为完整输出项，再转换到所选上游协议，不要求上游支持引用。Chat 模式由网关生成 Responses 响应和输出项 ID，并把同一 assistant 轮次的推理、文本、并行工具调用合并后发送给 Chat。网关只缓存经过完整校验的成功输出项，固定保留 5 分钟，读取不续期；缓存有容量上限且不写磁盘。具体预算、凭据隔离和淘汰规则见[引用兼容契约](docs/compatibility.md#responses-引用缓存)。

Chat 模式中，只有加密内容的推理历史或图片 `detail:original` 在调用上游前返回 400；可使用明文历史、本地 `item_reference` 和图片 auto/low/high。`reasoning.effort` 转为 `reasoning_effort`，`text.format` 和 `text.verbosity` 转为 Chat 对应字段；加密推理输出及推理摘要的显示控制不作等价保证。完整边界见[强制 Chat 模式](docs/compatibility.md#强制-chat-模式默认)。

引用缺失、过期、被淘汰、凭据或模型变化时，返回 OpenAI 格式 HTTP 400，错误码为 `reference_cache_miss`，不会静默丢弃历史。重启会清空缓存，旧引用失效后需要新建会话，或让客户端以 `store:false` 回传完整历史。依赖引用续轮时使用单实例部署，或在多实例部署中配置粘性路由；缓存不在实例间共享。该能力不新增配置、依赖或持久化设施，也不因出现引用自动启用上游存储。

## Responses HTTP 增量续轮

普通 `POST /v1/responses` 支持 `previous_response_id`，JSON 和 SSE 可以跨轮混用，两种上游模式均可使用。传入上一轮成功响应的 `id`，本轮 `input` 只发送新增内容；网关按相同凭据和模型查找完整历史，再转换到上游协议。`store:false` 也支持本地续轮。

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3000/v1",
  apiKey: process.env.OPENAI_API_KEY,
});
const first = await client.responses.create({
  model: "vendor/model", input: "记住：我的名字是小明。", store: false,
});
const next = await client.responses.create({
  model: "vendor/model", previous_response_id: first.id,
  input: "我叫什么名字？", store: false,
});
console.log(next.output_text);
```

工具调用后，同样通过 `previous_response_id` 加本轮 `function_call_output` 续轮。每轮重新提供 `instructions`、工具定义和生成参数；这些顶层参数不从上一轮继承。省略 ID 或设为 `null` 开始新会话，也可从仍在缓存中的任意成功响应分叉。

历史默认固定保留 5 分钟，读取不续期；每凭据最多 32 MiB / 128 条，全进程最多 128 MiB / 1024 条，超限 FIFO 淘汰。只有完整成功的响应写入历史，失败、取消和 incomplete 不写入；失败续轮不会删除仍有效的父响应。历史不写磁盘、不跨实例共享，重启会清空；多实例需要粘性路由。HTTP 历史和 WS 连接内历史独立，不能跨传输方式引用 ID。

默认 Chat 模式中，ID 过期、未命中或凭据/模型不匹配时返回 HTTP 400 `previous_response_not_found`；省略 ID 并回传完整历史即可继续。显式 Responses 上游模式在本地未命中时保留原有 ID 透传能力，由上游判断是否可用；这类响应不会作为完整历史缓存在本地。展开后超过 `BODY_LIMIT_BYTES` 返回 HTTP 413。容量、清理和存储语义见[HTTP 续轮契约](docs/compatibility.md#responses-http-历史缓存)。

## Responses WebSocket

连接 `ws://127.0.0.1:3000/v1/responses`，握手时携带 `Authorization: Bearer YOUR_UPSTREAM_KEY`。部署在 TLS 反向代理后使用 `wss://`，并让代理转发 WebSocket Upgrade。上游仍使用现有 HTTP/SSE，无需支持 WebSocket；`UPSTREAM_PROTOCOL=responses` 时改走上游 Responses HTTP/SSE。

Node.js 示例（使用项目的 `ws` 依赖）：

```js
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:3000/v1/responses", {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});
let continued = false;
ws.on("open", () => ws.send(JSON.stringify({
  type: "response.create", model: "vendor/model", input: "你好", store: false,
})));
ws.on("message", (data) => {
  const event = JSON.parse(data.toString());
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
  if (event.type === "error") { console.error(event.error); ws.close(); }
  if (event.type === "response.incomplete") ws.close();
  if (event.type === "response.completed") {
    if (continued) return ws.close();
    continued = true;
    ws.send(JSON.stringify({
      type: "response.create", model: "vendor/model",
      previous_response_id: event.response.id, input: "继续", store: false,
    }));
  }
});
ws.on("error", console.error);
```

每条客户端消息是一个 `response.create` JSON 对象。`stream` 可省略或设为 `true`，兼容 Codex CLI 的生成和 `generate:false` 预热请求；其他 `stream` 值及 `background` 字段返回 400。服务器按消息发送 `response.*` JSON 事件，没有 SSE 的 `event:` / `data:` 包装或 `[DONE]`。工具结果通过下一条请求的 `input` 中的 `function_call_output` 回传；`instructions`、工具定义和其他生成参数每轮重新提供。

HTTP 和 WS 均接受 Codex 的 `client_metadata`（JSON 对象或 `null`）。它只作为客户端诊断字段被校验后丢弃，不转发给上游、不混入 `metadata`、模型输入或续轮历史；原有 `metadata` 语义保持不变。

省略 `stream_id` 使用默认流；指定后，同名流按顺序执行，不同流可以并发，返回事件附带对应 `stream_id`。每个连接最多 32 个命名流。`previous_response_id` 可引用本连接同一模型的最近成功响应，也可从另一个流分叉；省略或设为 `null` 开始新会话。`generate:false` 只在本地准备输入上下文并返回空输出的响应 ID，不调用或预热上游模型。

每个流只保留最新成功响应的完整输入/输出历史；连接内总容量默认 32 MiB，超限按写入顺序淘汰，单条超限则不缓存，但仍完整返回生成结果。缺失、淘汰、模型不匹配或重连后的旧 ID 返回 `previous_response_not_found`，需要省略 ID 并发送完整历史。失败与 incomplete 响应不缓存；失败的同流续轮使其父 ID 失效，跨流失败不移除来源流的父 ID。

WS 始终向上游发送 `store:false`，不提供跨连接或持久化恢复。默认每 30 秒发送 ping，未收到下一周期的 pong 则断开；连接最长 60 分钟。断线、到期或服务关闭会取消该连接所有上游请求并清理历史。具体限制及错误见[WebSocket 兼容契约](docs/compatibility.md#responses-websocket)。

## 配置

`pnpm dev` 和 `pnpm start` 会在启动时加载项目根目录的 `.env`；已有环境变量优先。所有配置只在启动时读取。空的 Claude Code 最低/最高版本表示不限制对应边界。

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HOST` | `127.0.0.1` | 监听地址；容器内默认覆盖为 `0.0.0.0` |
| `PORT` | `3000` | 监听端口 |
| `UPSTREAM_BASE_URL` | 必填 | 上游基础 URL，只允许启动配置提供 |
| `UPSTREAM_PROTOCOL` | `chat` | `chat` 强制所有生成入口走 Chat；`responses` 恢复原 Responses 主路径与 Messages 受限回退 |
| `ALLOW_INSECURE_UPSTREAM` | `false` | 仅在显式为 `true` 时允许 HTTP，供本地开发使用 |
| `BODY_LIMIT_BYTES` | `33554432` | 请求 body 上限 |
| `CONNECTION_TIMEOUT_MS` | `0` | Socket 空闲超时；默认禁用，由上游总超时和 SSE 首字节/idle 超时约束请求 |
| `REQUEST_TIMEOUT_MS` | `30000` | Fastify request timeout |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求总超时 |
| `UPSTREAM_FIRST_BYTE_TIMEOUT_MS` | `60000` | SSE 首字节超时 |
| `UPSTREAM_STREAM_IDLE_TIMEOUT_MS` | `120000` | SSE 流空闲超时 |
| `UPSTREAM_SSE_FRAME_LIMIT_BYTES` | `8388608` | 单个上游 SSE frame 的 UTF-8 wire 上限 |
| `UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES` | `8388608` | 单个 Responses/Anthropic 流 item 的输出与状态预算 |
| `UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES` | `33554432` | 单条流全部输出与保留状态的聚合预算 |
| `UPSTREAM_JSON_BODY_LIMIT_BYTES` | `33554432` | 成功的非流上游 JSON body 上限 |
| `UPSTREAM_ERROR_BODY_LIMIT_BYTES` | `65536` | 上游错误外壳 body 上限 |
| `UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES` | `1048576` | 单次工具参数流上限 |
| `UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES` | `8388608` | 单条响应中全部工具参数流上限 |
| `ANTHROPIC_PING_INTERVAL_MS` | `15000` | Anthropic 命名 `event: ping` 间隔 |
| `SSE_HEARTBEAT_INTERVAL_MS` | `15000` | Responses / Chat 的 SSE 注释心跳间隔；首个事件后启动，`0` 禁用 |
| `WEBSOCKET_PING_INTERVAL_MS` | `30000` | WS ping/pong 心跳间隔，`0` 禁用 |
| `WEBSOCKET_MAX_CONNECTION_MS` | `3600000` | WS 连接寿命，范围 1–3600000 ms |
| `WEBSOCKET_MAX_PENDING_REQUESTS` | `64` | 每个连接执行中与排队请求的总数上限；这些请求的原始消息总字节数还受 `BODY_LIMIT_BYTES` 限制 |
| `WEBSOCKET_HISTORY_LIMIT_BYTES` | `33554432` | 每个 WS 连接保留的全部流历史的 JSON 字节预算 |
| `RESPONSES_HISTORY_TTL_MS` | `300000` | HTTP Responses 历史固定有效期，单位 ms，必须大于 0 |
| `RESPONSES_HISTORY_MAX_CREDENTIAL_BYTES` | `33554432` | HTTP 历史每凭据字节预算，各模型共用；最多 128 条 |
| `RESPONSES_HISTORY_MAX_BYTES` | `134217728` | HTTP 历史全进程字节预算；最多 1024 条，单条另受 `BODY_LIMIT_BYTES` 限制 |
| `SHUTDOWN_GRACE_MS` | `10000` | 优雅关闭期限 |
| `CLAUDE_CODE_MIN_VERSION` | 空 | 接受范围的闭区间下界，例如 `2.1.63` |
| `CLAUDE_CODE_MAX_VERSION` | 空 | 接受范围的闭区间上界，例如 `2.5.0` |
| `PROMPT_CACHE_BREAKPOINTS_ENABLED` | `true` | Claude Code cache planner 开关 |
| `READ_TOOL_COMPAT_ENABLED` | `true` | Claude Code `Read` 参数修正开关 |
| `SYNTHETIC_THINKING_SIGNATURE_ENABLED` | `true` | Claude Code synthetic thinking signature 开关 |

非法布尔值、整数、SemVer 边界或 URL 会导致启动失败。

## Claude Code 兼容层

版本识别优先读取首个 system attribution 文本中的：

```text
x-anthropic-billing-header: cc_version=2.1.220.04c; ...
```

只比较前三段 `2.1.220`。缺失时回退读取：

```http
User-Agent: claude-cli/2.1.220 (external, cli)
```

system attribution 与 User-Agent 冲突时以前者为准。只有严格、有效且位于配置范围内的版本启用以下三个独立 shim；缺失或 malformed 版本作为普通 Anthropic SDK 请求放行，合法但越界版本返回 Anthropic HTTP 400 `invalid_request_error`。

- prompt-cache planner：显式 breakpoint 优先，最多四个；当前上游能力为 `prompt-cache-key`，不编码 Anthropic `cache_control`、TTL 或断点字段。`PROMPT_CACHE_BREAKPOINTS_ENABLED` 只控制断点规划，不控制默认缓存键，也不会把 planned 冒充 encoded/hit。
- `Read` 参数修正：仅删除顶层、string 且严格等于空字符串的 `pages`，其余 JSON 字节语义保持不变。
- thinking signature：为缺失签名的 thinking block 生成 `Buffer.from(crypto.randomUUID(), "utf8").toString("base64")`；真实签名优先。synthetic 值不会作为 OpenAI encrypted reasoning 回放。

## Web Search

内置 Web Search 通过独立 provider registry 执行，当前 provider 为 DuckDuckGo。Anthropic `web_search_*` 与 Claude Code deferred `WebSearch` 会转换为网关内部保留工具，由网关执行搜索并把结果回填给上游模型；上游模型随后继续生成最终响应。

`stream:true` 的每一轮模型调用都使用真实 SSE，普通文本实时转发，内部搜索调用由网关消费；搜索等待期间 Anthropic 连接继续发送 ping。模型调用、搜索执行和受限 Chat 回退共用请求总超时，最终 usage 累计所有模型轮次的 token 和缓存用量。成功进入任一模型轮次后不再允许 Chat 回退。

Anthropic `max_uses`、`allowed_domains` / `blocked_domains` 和 Responses `filters.allowed_domains` 会保留并在搜索执行时生效；`max_uses:0` 禁用搜索。强制搜索完成一次后恢复自动工具选择，使模型能够生成最终回答。

Anthropic JSON/SSE 出口会生成原生 `server_tool_use` / `web_search_tool_result` 块，并同步 `usage.server_tool_use.web_search_requests`。后续多轮对话回传这些 server-search block 时，网关会识别并过滤自身生成的 replay 数据。普通 function 即使名称为 `web_search`，仍按普通 function 处理，不会被当作内置 Web Search。

Responses JSON/SSE 出口会生成 `web_search_call`，SSE 在实际搜索前发送 `in_progress` / `searching`，结果返回后发送 `completed`。通过 `include:["web_search_call.action.sources"]` 获取搜索来源；答案里实际出现的检索链接会附带 `url_citation`。返回的 `output` 可以直接放入下一轮 `input`，搜索记录作为历史上下文处理，不重新执行。

Responses 支持显式搜索 `tool_choice`、`allowed_tools`、`max_tool_calls`、上下文大小及域名过滤。DuckDuckGo Lite 的位置只作为检索提示；不支持离线缓存和图片检索，相关请求返回 400。具体映射、历史回传和兼容性变化见 [Responses 搜索兼容说明](docs/compatibility.md#responses-网关搜索)。

## 兼容范围

Chat 入口支持单候选答案、文本、图片输入（保留 detail）、developer 角色、函数工具及调用回传、reasoning/refusal、采样控制，以及 text/json_object/json_schema 输出格式（保留名称和 strict）。`max_tokens` 与 `max_completion_tokens` 均支持，但不能同时提供。`n>1`、音频、logprobs、旧式 functions/function_call 和内置搜索参数返回 400；普通搜索函数由客户端执行。

兼容 WorkBuddy 在 `messages[]` 中附加的 `agent` 客户端标记（字符串或 `null`）：校验后丢弃，不作为模型角色、消息 `name` 或上游参数。其他未知消息字段继续返回 400。

CC Switch 将 Codex 请求转换为 Chat 时使用的思考扩展可在 Chat 入口校验并原样转发，具体结构与边界见 [CCS 思考参数兼容](docs/compatibility.md#ccs-思考参数兼容)。

支持 JSON 与 SSE：text、system、URL/Base64 image、function tool、tool call/result、并行与交错工具调用、reasoning/thinking、usage、已有 search result、URL citation/annotation。Anthropic `output_config.effort` 的 `low | medium | high | xhigh | max | null` 会转为 Responses `reasoning.effort`，token counting 同样保留，Chat fallback 转为 `reasoning_effort`。Anthropic `output_config.format` 支持 `null` 或 `{ type: "json_schema", schema: {...} }`：Responses 映射到 `text.format`，token counting 同样保留，Chat fallback 映射到 `response_format.json_schema`。

Responses 入口支持 `text.format` 的 text/json_object/json_schema 和 `text.verbosity`，保留图片 `detail` 及函数 `strict` 的显式值和缺省状态。流式输出保留未完成状态，并支持多文本块引用。字段映射、工具失败结果和兼容性变化以[兼容契约](docs/compatibility.md)为准。

当前仍不支持 document/PDF、audio、file upload 或 background Responses 生命周期；`background:true` 会被拒绝。Anthropic `tool_result` 中的 image/search_result 内容同样在上游调用前返回 Anthropic 400。上游 refusal 在 Anthropic 出口折为 text 块并输出 `stop_reason:"refusal"`。完整矩阵和有损语义见 [docs/compatibility.md](docs/compatibility.md)。

## Docker

直接使用 Docker：

```bash
docker build -t llm-protocol-gateway .
docker run --rm \
  -p 3000:3000 \
  -e UPSTREAM_BASE_URL=https://gateway.example.com/v1 \
  llm-protocol-gateway
```

使用 Docker Compose：

```bash
cp .env.example .env
# 编辑 .env，至少设置 UPSTREAM_BASE_URL
docker compose up --build
```

若上游运行在 Linux 宿主机，Compose 已将 `host.docker.internal` 映射到 Docker host gateway。以宿主机上游端口 `8000` 为例：

```dotenv
UPSTREAM_BASE_URL=http://host.docker.internal:8000/v1
ALLOW_INSECURE_UPSTREAM=true
```

HTTP 上游必须显式启用 `ALLOW_INSECURE_UPSTREAM`；使用 HTTPS 时应填写 `https://...` 并保持该开关为 `false`。宿主机上游必须监听 `0.0.0.0` 或 Docker 网桥地址，仅监听 `127.0.0.1` 时 bridge 网络中的容器无法连接。生产环境应通过防火墙只允许 Docker 网桥访问上游端口，避免将其直接暴露到公网。

默认通过 `http://127.0.0.1:3000` 访问。宿主机端口可以通过 `GATEWAY_PORT` 调整，例如 `GATEWAY_PORT=8080 docker compose up --build`；容器内部仍监听 `3000`。停止服务：

```bash
docker compose down
```

Compose 服务不持久化数据，不需要挂载数据卷或启动额外依赖；重建或重启会清空 Responses 引用和历史缓存。它会复用镜像内置的 `/health/ready` healthcheck；该检查确认网关进程可接受请求，不代表上游服务连通。

镜像使用 Node 24 多阶段构建、固定 pnpm 10.6.3，只携带 production dependencies，并以非 root `node` 用户运行。镜像内置 `/health/ready` healthcheck。

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | watch 模式启动 |
| `pnpm format` | 格式化 |
| `pnpm format:check` | 检查格式 |
| `pnpm lint` | lint |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm test` | 全量测试 |
| `pnpm test:coverage` | 测试与覆盖率 |
| `pnpm build` | 生成 `dist/` |
| `pnpm start` | 启动已构建服务 |

## 安全不变量

- 上游URL只能来自启动配置。
- 默认仅允许HTTPS，本地HTTP必须显式开启。
- API key、authorization、prompt、工具参数、图片、reasoning、signature不得写日志。
- 协议转换接口不向客户端暴露上游原始错误 body；两个 GET 透传接口保留上游错误状态与正文。
- 上游路径必须是固定枚举。
- 禁止SDK自动重试，避免重复计费或重复工具执行。
- body、工具参数、流缓冲和超时必须有上限。
- client disconnect应传播AbortSignal。
- 不持久化凭据、prompt、会话或响应；Responses 引用与 HTTP 历史使用有容量上限的短期缓存，WS 另在连接内暂存历史，断线清理。调用凭据仅在处理请求或维持 WS 连接时使用，缓存键只保存凭据的 HMAC 散列。

## 设计依据

- Anthropic Messages、Streaming、Effort、Prompt Caching：<https://platform.claude.com/docs/en/api/messages/create>、<https://platform.claude.com/docs/en/build-with-claude/streaming>、<https://platform.claude.com/docs/en/build-with-claude/effort>、<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Claude Code Gateway Protocol：<https://code.claude.com/docs/en/llm-gateway-protocol>
- OpenAI Responses 与 Streaming：<https://developers.openai.com/api/reference/resources/responses>、<https://developers.openai.com/api/docs/guides/streaming-responses>
- Fastify validation：<https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/>

架构决策见 [docs/decisions/0001-stateless-canonical-gateway.md](docs/decisions/0001-stateless-canonical-gateway.md)。
