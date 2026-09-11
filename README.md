# LLM Protocol Gateway

一个不持久化数据的 OpenAI / Anthropic 协议转换网关。服务使用 TypeScript ESM、Fastify 5 和 Node.js 24，对外提供 Anthropic Messages、Anthropic token counting、OpenAI Responses 与 Chat Completions 接口；不使用数据库。为兼容 Chatbox 1.21.1 的 Responses 引用续轮，仅在进程内短期缓存成功的输出项，按调用凭据和请求模型隔离；不缓存请求 prompt 或整段历史，不保存 API key 原文。

## 路由

| 对外接口 | 上游接口 | 行为 |
| --- | --- | --- |
| `POST /v1/messages` | `/v1/responses` | 默认路径；仅在明确不存在 Responses endpoint 时受限回退 `/v1/chat/completions` |
| `POST /v1/messages/count_tokens` | `/v1/responses/input_tokens` | 精确委托；不本地估算，不回退 Chat |
| `POST /v1/responses` | `/v1/responses` | 完整 decode → canonical IR → encode；永不回退 Chat |
| `POST /v1/chat/completions` | `/v1/chat/completions` | 完整 decode → canonical IR → encode；直接请求 Chat，不回退或重试 |
| `GET /v1/usage` | `/v1/usage` | 透传用量查询；字段含义由上游定义 |
| `GET /v1/models` | `/v1/models` | 透传模型列表查询 |
| `GET /health/live` | 无 | 进程存活检查 |
| `GET /health/ready` | 无 | 就绪检查 |

`/v1/messages` 只在尚无上游语义事件、尚未向客户端写入 SSE 字节，并且 Responses 返回以下明确 endpoint 缺失信号时回退：

- HTTP 405 或 501；
- HTTP 404 且错误码为 `route_not_found`、`endpoint_not_found`、`unsupported_endpoint` 或 `not_implemented`。

401、403、429、5xx、timeout、disconnect、`model_not_found`、模糊 404、HTTP 200 后 malformed SSE，以及任何已产生语义事件或客户端写入后的错误都不会触发回退。SDK 自动重试被禁用，每个 adapter attempt 最多调用一次上游。

## 快速开始

要求：

- Node.js 24；
- pnpm 10.6.3；
- 一个支持目标接口的 OpenAI-compatible 上游：Responses/Anthropic 主路径使用 Responses，Chat 入口及 Anthropic 回退使用 Chat Completions；生成接口需接受 `prompt_cache_key`。

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

Chatbox 1.21.1 回传的 `item_reference` 在网关内展开为完整输出项，再交给既有 Responses 转换流程，不要求上游支持引用。网关只缓存经过完整校验的成功 Responses 输出项，固定保留 5 分钟，读取不续期；缓存有容量上限且不写磁盘。具体预算、凭据隔离和淘汰规则见[引用兼容契约](docs/compatibility.md#responses-引用缓存)。

引用缺失、过期、被淘汰、凭据或模型变化时，返回 OpenAI 格式 HTTP 400，错误码为 `reference_cache_miss`，不会静默丢弃历史。重启会清空缓存，旧引用失效后需要新建会话，或让客户端以 `store:false` 回传完整历史。依赖引用续轮时使用单实例部署，或在多实例部署中配置粘性路由；缓存不在实例间共享。该能力不新增配置、依赖或持久化设施，也不因出现引用自动启用上游存储。

## 配置

`pnpm dev` 和 `pnpm start` 会在启动时加载项目根目录的 `.env`；已有环境变量优先。所有配置只在启动时读取。空的 Claude Code 最低/最高版本表示不限制对应边界。

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `HOST` | `127.0.0.1` | 监听地址；容器内默认覆盖为 `0.0.0.0` |
| `PORT` | `3000` | 监听端口 |
| `UPSTREAM_BASE_URL` | 必填 | 上游基础 URL，只允许启动配置提供 |
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

Compose 服务不持久化数据，不需要挂载数据卷或启动额外依赖；重建或重启会清空 Responses 引用缓存。它会复用镜像内置的 `/health/ready` healthcheck；该检查确认网关进程可接受请求，不代表上游服务连通。

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
- 不持久化凭据、prompt、会话或响应；Responses 成功输出项仅在有容量上限的进程内缓存中短期保留，不缓存请求 prompt、整段历史或 API key 原文。

## 设计依据

- Anthropic Messages、Streaming、Effort、Prompt Caching：<https://platform.claude.com/docs/en/api/messages/create>、<https://platform.claude.com/docs/en/build-with-claude/streaming>、<https://platform.claude.com/docs/en/build-with-claude/effort>、<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Claude Code Gateway Protocol：<https://code.claude.com/docs/en/llm-gateway-protocol>
- OpenAI Responses 与 Streaming：<https://developers.openai.com/api/reference/resources/responses>、<https://developers.openai.com/api/docs/guides/streaming-responses>
- Fastify validation：<https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/>

架构决策见 [docs/decisions/0001-stateless-canonical-gateway.md](docs/decisions/0001-stateless-canonical-gateway.md)。
