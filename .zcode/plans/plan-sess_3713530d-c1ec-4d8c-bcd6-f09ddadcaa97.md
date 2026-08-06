# OpenAI / Anthropic 无状态协议转换层实施计划

## 目标

从空目录新建一个 pnpm + TypeScript + Fastify 服务，无数据库、无管理后台、无会话存储：

```text
Claude Code / Anthropic SDK             OpenAI SDK
POST /v1/messages                       POST /v1/responses
POST /v1/messages/count_tokens                 │
              │                                │
              └── wire decoder → 中性 IR ←────┘
                                  │
                         compatibility policies
                                  │
                    ┌─────────────┴────────────┐
                    ▼                          ▼
          upstream /v1/responses     upstream /v1/chat/completions
                 默认主路径              Anthropic 受限回退
```

上游采用 generic OpenAI-compatible profile，同时提供 Responses 与 Chat。调用方 API key 和 `model` 原样用于上游请求；上游 URL 只来自启动配置。

## 已确认的协议与路由行为

- 对外实现：
  - `POST /v1/messages`
  - `POST /v1/messages/count_tokens`
  - `POST /v1/responses`
  - `GET /health/live`
  - `GET /health/ready`
- `/v1/messages` 默认转换为上游 Responses。
- 仅当 Responses 明确返回 endpoint 不支持（405/501，或 code/body 明确是路由缺失的 404）、上游尚未产生任何语义事件且客户端尚未收到任何字节时，Anthropic 请求才回退 Chat。
- 401/403、429、超时、连接中断、5xx、模型不存在、模糊 404、Web Search 不支持、转换错误均不触发回退。
- `/v1/responses` 始终走上游 Responses，完整解码/规范化/重编码，永不回退 Chat。
- SDK 自动重试关闭；每个 adapter 最多尝试一次，防止重复计费或工具执行。
- 无状态：`store:false` 用于由 Anthropic 转出的 Responses；外部 Responses 的 `previous_response_id`/`store` 可由上游托管，但本服务不落库。首版拒绝 `background:true`，因为不提供 GET/cancel/delete 生命周期。

## 首版兼容范围

支持 JSON 与 SSE，覆盖：

- text、system、user/assistant 历史
- URL/Base64 图片
- function tools、tool use/result、tool choice、并行工具调用
- Responses reasoning 和常见 Chat `reasoning_content`/`reasoning` 扩展
- usage、cache-read/reasoning token 派生
- 已有 `search_result` 与 URL citation/annotation
- Anthropic / OpenAI 两套错误外壳与 request ID

首版不支持：document/PDF、audio、file upload、background Responses 生命周期、Anthropic 原生 encrypted-thinking 验证、redacted-thinking 精确保真、服务端存储、限额系统和管理 UI。

## Claude Code 版本门控

不做复杂客户端画像，只匹配版本。

### 版本来源

优先读取 Anthropic 请求首个 system attribution 文本块中的官方字段：

```text
x-anthropic-billing-header: cc_version=2.1.220.04c; ...
```

只比较前三段 `2.1.220`；末尾会话指纹不属于版本。该块缺失时回退解析：

```http
User-Agent: claude-cli/2.1.220 (external, cli)
```

- system attribution 是官方 Gateway Protocol 中的版本载体；User-Agent 只是当前客户端实现的回退来源。
- 两者都有且冲突时，以 system `cc_version` 为准，并记录低敏 mismatch 事件。
- 不使用 `anthropic-version` 或 `X-Stainless-Package-Version` 作为客户端版本。
- 只接受严格 SemVer 三段版本，不做宽松 `coerce`。

### 范围配置

```text
CLAUDE_CODE_MIN_VERSION=
CLAUDE_CODE_MAX_VERSION=
```

- 默认均为空，接受所有可解析 Claude Code 版本。
- 闭区间比较：`version >= min && version <= max`。
- 任一边界为空则只约束另一侧。
- 启动时验证边界格式与 `min <= max`；非法配置拒绝启动。
- prerelease 按 SemVer 规则比较，build metadata 不影响优先级。
- 合法但越界：上游零调用，返回 HTTP 400 + Anthropic `invalid_request_error`，区分低于最低/高于最高。
- 版本缺失或非法：按用户要求降级为普通 Anthropic SDK 请求，正常放行，但不启用下述三个 Claude Code shim。
- `/v1/messages` 和 `/v1/messages/count_tokens` 共用该门控；`/v1/responses` 不受影响。

版本只是可伪造的兼容性分类信号，不参与鉴权或权限提升。

## 三个 Claude Code shim

三个 shim 只在以下条件同时满足时生效：

1. Anthropic 路由；
2. 成功解析合法 Claude Code 版本；
3. 版本在允许范围内；
4. 对应独立开关为 true。

```text
PROMPT_CACHE_BREAKPOINTS_ENABLED=true
READ_TOOL_COMPAT_ENABLED=true
SYNTHETIC_THINKING_SIGNATURE_ENABLED=true
```

非法布尔配置拒绝启动。配置在请求开始时冻结，不在流中重新读取。

### 1. 自动 prompt-cache breakpoint 优化

采用“供应商无关 planner + provider encoder”，而不是把 Anthropic `cache_control` 盲发给未知 OpenAI-compatible 上游。

planner：

- 输入不可变 IR，输出候选 node ID、优先级、原因，不修改文本、块顺序或工具 schema。
- 缓存前缀顺序保持 `tools → system → messages`。
- 用户显式断点优先且不移动、不覆盖；自动候选只占剩余槽位。
- 每次请求最多规划 4 个断点。
- 优先稳定工具定义、稳定 system、历史轮次边界；不把动态当前 user tail 当成稳定前缀。
- `count_tokens` 复用相同语义转换，但不发送缓存写入 metadata。
- 每个 fallback attempt 从不可变 IR 重新 legalize/encode，不复用 Responses wire payload。

provider encoder：

- generic profile 默认依赖上游自动前缀缓存；只发送已由静态 capability 配置声明支持的公共字段。
- 可配置启用标准 `prompt_cache_key`、GPT-5.6+ `prompt_cache_options` 与 block breakpoint，或未来供应商专用 encoder。
- 未知模型/能力不盲发显式字段，只保留稳定序列化与 planner 观测。
- Anthropic 5m/1h 与 OpenAI 30m/旧 retention 不做伪等价映射。
- tool definitions 若目标协议没有合法显式 marker，只依赖自动前缀缓存。
- cache key 不含原始 prompt/key；按调用方凭据摘要、模型与稳定结构生成请求级隔离 key，不落盘、不写日志。

观测严格区分：`planned`、`encoded`、`cache hit/write reported by usage`，不把计划成功冒充缓存命中。

AxonHub 的精确通用 breakpoint planner 未获得可验证源码结论，因此此项明确依据当前 Anthropic/OpenAI 官方缓存规则重新设计；不虚构为逐行复刻。

### 2. Claude Code `Read` 工具参数处理

已核实 AxonHub 的可观察目标：GPT 系列可能生成：

```json
{"file_path":"/tmp/a.go","pages":""}
```

Claude Code `Read` 只接受有效页范围或省略字段。兼容输出为：

```json
{"file_path":"/tmp/a.go"}
```

规则：

- 工具名大小写不敏感等于 `Read`，且请求已通过 Claude Code 版本匹配。
- 只删除顶层、类型为 string、值严格等于空字符串的 `pages`。
- `"pages":"1-5"`、`"pages":" "`、null、数字、数组、嵌套 `pages` 均不修改。
- 普通 Anthropic SDK、自定义同名工具但没有 Claude Code profile、Responses 客户端均不触发。
- 每个 tool index 独立缓冲参数，支持并行和 `0 → 1 → 0` 交错；字符串分片先存数组，结束时 join，避免 O(n²)。
- 只在完整 JSON 后执行纯函数；不在 SSE 分片上正则替换。
- 使用 offset-aware scanner 删除目标属性，保留其余数字精度、键顺序、空白与转义，不用 `JSON.parse → stringify` 改写其他内容。
- 流与非流调用同一个 normalizer。
- malformed JSON 返回协议错误，不用 `jsonrepair`、不静默变成 `{}`、不输出无效参数。
- 设置单调用及单流 UTF-8 缓冲上限；超限终止并返回 `TOOL_ARGUMENTS_TOO_LARGE`，参数内容不进入日志。
- SSE 可先发 `content_block_start`，缓冲后发一个规范化 `input_json_delta` 再 stop；等待期间持续发 ping。

### 3. 随机 UUID thinking signature

行为兼容 AxonHub 的精确格式：

```ts
Buffer.from(crypto.randomUUID(), "utf8").toString("base64")
```

即 UUID v4 的 36 字符文本做标准 Base64，结果为 48 字符；不是裸 UUID，也不是 UUID 的 16 原始字节。

- 每个缺真实签名的 thinking block 独立生成一次。
- 真实非空 signature 优先；空字符串视为缺失。
- JSON 与 SSE 共用同一个 block finalizer 和可注入 UUID factory。
- SSE 等到 item-done/终止水位再补占位，顺序固定：`thinking_delta* → signature_delta → content_block_stop`。
- 允许封口前迟到的真实签名胜出；封口后再到真实签名视为上游事件顺序错误，不输出第二个空 thinking block。
- 多 reasoning item 保持多 block，非流和流式逻辑结果一致。
- 历史 signature 原样保留，不 trim、不 decode、不重编码。
- synthetic provenance 存在 request-local sidecar；占位签名绝不写入 OpenAI `encrypted_content`，也不冒充 provider continuation。
- 客户端后续回传值按 opaque compatibility data 处理；无需数据库。相同请求重试可能产生不同 UUID，不承诺响应幂等重放。
- 随机源失败返回内部错误，不 panic 服务。
- 开关关闭时回到用户已选择的宽松无签名 thinking 行为。

## Web Search 与引用

独立定义 `WebSearchProvider`、registry 和 capability contract：

- 负责供应商工具声明、请求编码、流事件、结果与 URL annotation 解码。
- 首版只注册 `unsupported`，模型要求真正执行 Web Search 时，在零上游调用下返回当前入口的协议错误。
- 名为 `web_search` 的普通 function 不误判为 built-in tool。
- 请求中已有 `search_result` 可转换为稳定的 title/source/content 表达。
- 上游已有 URL citation/annotation 转为 Anthropic citation/citations_delta；字段不足时保留可见 URL/标题并记录有损转换。
- 不伪造 encrypted index，也不自行联网搜索。
- 未来供应商 URL/key 只能来自启动配置。

## 中性 IR 与 sidecar

借鉴 AxonHub 的“双 adapter + IR + 每请求流状态机”，但 IR 必须真正中性：

- 有序 discriminated unions：text、image、reasoning、function_call、function_result、search_result、citation、refusal。
- 保存原 item/block ID、顺序索引、tool call ID、来源协议、canonical usage/finish reason/error。
- `RequestContext`：入口协议、stream、Claude Code version/profile、三个开关快照、AbortSignal、capability snapshot。
- `OpaqueContinuation`：真实 signature、encrypted reasoning、previous_response_id 等带来源标记的数据；禁止通用 extension bag 跨 provider 回放。
- provider-private sidecar 仅在同协议、结构指纹未变化且字段不涉及 URL/认证/路由时回放；标准规范化字段始终优先。
- 缓存 planner、Read normalizer、synthetic signature 都是 compatibility policy，不是 IR 固有语义。

建议目录：

```text
src/
  app.ts
  server.ts
  config.ts
  core/{ir,events,errors,extensions}.ts
  profiles/claude-code/{version,policy}.ts
  policies/cache/{planner,capabilities}.ts
  policies/read-tool.ts
  policies/thinking-signature.ts
  protocols/anthropic/{schema,decode,encode,stream}.ts
  protocols/openai-responses/{schema,decode,encode,stream}.ts
  protocols/openai-chat/{schema,decode,encode,stream}.ts
  upstream/{client,routing}.ts
  providers/web-search/{types,registry,unsupported}.ts
  http/{auth,errors,health}.ts
  stream/{session,ping}.ts

test/{unit,integration,contract,fixtures}/
docs/compatibility.md
tasks/{plan,todo}.md
```

命名使用 `decodeAnthropicRequest` / `encodeResponsesRequest`，不采用方向含混的 inbound/outbound。Fastify 路由不处理 tool JSON、thinking 或 block index。

## SSE 与 HTTP 生命周期

使用 Fastify 5 + `@fastify/sse` manual mode：

- body 的 `stream` 决定 JSON/SSE；首写才提交 headers；`send()`负责 backpressure。
- 关闭插件 comment heartbeat，自行发送 Anthropic命名 `event: ping`。
- 每请求独立状态机保存 response/model、item/block、工具参数、usage、终态和“是否已产生上游语义事件/向客户端写入”。
- Anthropic 严格生成：`message_start → block start/delta/stop* → message_delta → message_stop`。
- 工具 `partial_json` 终态验证；除 `Read` shim 外保持上游分片。
- `message_start` usage 使用零值，终态发送上游累计 usage；不伪造 1/1 token。
- 首帧前错误用正确 HTTP JSON；首帧后用当前协议的流内 error 后关闭。
- 监听 `request.raw` close/aborted，并桥接自建 AbortController；不假设 Fastify Request 自带 signal。
- 客户端断开立即 abort 上游并清理 ping/Read/reasoning 缓冲。
- 上游缺 terminal、重复终态、非法顺序、用户可见未知事件均失败关闭，不静默吞掉。
- JSON 由 canonical events reducer 折叠，SSE 编码同一事件流，确保内容、顺序、工具、thinking、signature、usage 和终态 parity。
- graceful shutdown 在 `preClose` abort active streams，有限 grace period 后关闭，避免 Docker stop 挂住。

## 鉴权、错误和安全

- Anthropic 接受 `x-api-key`，并兼容 Claude Code Bearer；两者同时存在且不同则拒绝。Responses 接受 Bearer。
- 每请求用透传 key 创建或调用无共享密钥状态的上游 client；统一转为 upstream Bearer。
- 上游 401/403 在透传模式下归因客户端并映射当前协议错误；原始 body 清洗。
- `UPSTREAM_BASE_URL` 仅环境配置，默认要求 HTTPS；本地 HTTP 需显式开启。
- Anthropic body limit 32 MiB；设置输出 token、tool arguments、headers、首字节、流空闲和总时长上限。
- 日志脱敏 authorization/x-api-key；不记录 prompt、请求体、工具参数、文件路径、Base64 图片、reasoning 或 signature。
- 只记录 request ID、入口协议、stream、attempt、fallback reason、版本门控结果、三个 policy 的 applied/skipped reason、延迟、上游状态和 usage。
- model/API key 不作为 metrics label；版本字段不是安全凭据。
- CORS 默认关闭，trustProxy 默认 false；本地监听 127.0.0.1，容器监听 0.0.0.0。
- pnpm 首次安装禁用 lifecycle scripts；提交唯一 lockfile，运行生产依赖 audit。

## 技术基线与交付

- Node.js 24 LTS
- pnpm 11（`packageManager` 固定精确版本）
- TypeScript ESM 当前稳定版，安装后立即 typecheck
- Fastify 5、`@fastify/sse`、OpenAI Node SDK 7
- TypeBox + Fastify JSON Schema 做 wire 验证；语义约束另做纯函数校验
- Vitest；Anthropic SDK作为开发期契约客户端
- 多阶段 Dockerfile、`.dockerignore`、非 root 运行、Node 实现的 healthcheck；单服务不增加 Compose
- `.env.example` 中 min/max 默认留空，README 用 `2.1.63` / `2.5.0` 举例

## 实施任务

### 阶段 1：规格、脚手架和基础设施

1. 创建 `tasks/plan.md`、`tasks/todo.md`、`docs/compatibility.md`，初始化 pnpm/TS/Fastify、format/lint/test/build、lockfile。
2. 配置解析、日志脱敏、app/server 分离、health、超时和优雅关闭。
3. 测试先行定义 IR、canonical events、errors、RequestContext、OpaqueContinuation 与受约束 sidecar。
4. 实现 Claude Code version extractor/range gate，覆盖 attribution、UA fallback、冲突、缺失/非法降级、闭区间和 400 越界。

检查点：frozen install、format、lint、typecheck、unit tests、build；health 可实际启动/关闭。

### 阶段 2：Anthropic → Responses 非流纵向切片

5. Anthropic headers/body schema 与请求 decoder：text/system/images/tools/thinking/search_result。
6. IR → Responses encoder、调用方 key/model 透传、`store:false`、timeouts/request ID/AbortController。
7. Responses JSON → canonical events → Anthropic Message：有序内容、usage、stop/error。
8. 接通 `/v1/messages` 非流并用本地 mock Responses 上游端到端验证。

检查点：Anthropic SDK 可完成非流文本、图片和并行工具调用。

### 阶段 3：三个 Claude Code shim

9. cache planner + generic provider capability encoder；验证 IR deep-freeze、显式断点优先、4槽、Responses/Chat独立编码、count_tokens无写入字段。
10. `Read` normalizer + per-index bounded buffer；覆盖 pages矩阵、原字节保留、交错tools、malformed和上限。
11. synthetic signature finalizer；覆盖精确 Base64(UUIDv4文本)、每block一次、真实签名优先、多item、历史opaque和随机源失败。
12. 三项开关 8 种组合及普通SDK/非法版本/越界版本隔离测试。

检查点：只有合法且范围内 Claude Code profile 会触发 shim；JSON/SSE逻辑结果一致。

### 阶段 4：SSE 与 Chat fallback

13. Responses SSE decoder状态机：typed item顺序、任意tool分片、reasoning、usage、terminal/error。
14. Anthropic SSE encoder：manual mode、命名ping、backpressure、流内错误、断连清理。
15. Chat JSON/SSE adapter与严格fallback classifier；从不可变IR重新应用Chat cache encoder。
16. 测试首帧/语义事件前后错误、200后断流、404分类、401/429/5xx/timeout不回退、客户端abort。

检查点：真实HTTP流覆盖多block、并行tool、Read、thinking/UUID、ping和断连。

### 阶段 5：Responses入口、计数和Web Search边界

17. `/v1/responses` JSON完整规范化与同协议sidecar，拒绝background。
18. `/v1/responses` SSE重编码与terminal parity，验证永不Chat fallback/不触发Claude Code shim。
19. `/v1/messages/count_tokens` → upstream `/v1/responses/input_tokens`；上游不支持返回501，不本地估算。
20. WebSearchProvider/registry/unsupported；已有search_result和URL citation JSON/SSE fixtures。

检查点：OpenAI SDK与Anthropic SDK均可调用；实际Web Search零上游调用稳定失败。

### 阶段 6：加固、Docker和文档

21. 32MiB、header/tool缓冲、输出、超时、取消、错误清洗、日志泄密和malformed SSE滥用测试。
22. fixture矩阵：协议 × JSON/SSE × text/image/tool/reasoning/citation × success/error；随机tool分片与stream→JSON parity。
23. README、`.env.example`、兼容矩阵、curl/SDK/Claude Code配置和所有有损语义说明。
24. 多阶段Dockerfile，以非root运行并实际验证health与graceful stop。
25. 完整质量审查与简化，运行所有门禁。

## 最终验证

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm audit --prod
docker build -t llm-protocol-gateway .
```

运行时验证：

- Anthropic/OpenAI SDK的JSON与SSE调用
- Claude Code attribution/UA版本矩阵
- `Read pages:""` 修正及普通SDK不误触发
- UUID精确编码、迟到真实签名、多block parity
- cache planned/encoded/usage hit三阶段
- Responses→Chat受限回退
- tool arguments任意分片、并行/交错工具
- ping、首帧前/后错误、客户端断连abort、graceful shutdown
- Docker非root与healthcheck

没有真实上游URL/key时，live计费测试明确标为未运行；本地mock与SDK契约测试仍必须全部通过。

## 设计依据

- Anthropic Messages/Streaming/Errors/Prompt Caching：
  - https://platform.claude.com/docs/en/api/messages/create
  - https://platform.claude.com/docs/en/build-with-claude/streaming
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code Gateway Protocol：
  - https://code.claude.com/docs/en/llm-gateway-protocol
- OpenAI Responses/Streaming/Function Calling/Prompt Caching：
  - https://developers.openai.com/api/reference/resources/responses/methods/create
  - https://developers.openai.com/api/docs/guides/streaming-responses
  - https://developers.openai.com/api/docs/guides/function-calling
  - https://developers.openai.com/api/docs/guides/prompt-caching
- Fastify/SSE：
  - https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
  - https://github.com/fastify/sse
- AxonHub固定参考commit `131dc03dcbeb64d10773bc54abacec9b36b3f049`：
  - IR/adapter边界：https://github.com/looplj/axonhub/blob/131dc03dcbeb64d10773bc54abacec9b36b3f049/llm/model.go
  - `Read pages:""`：https://github.com/looplj/axonhub/blob/131dc03dcbeb64d10773bc54abacec9b36b3f049/llm/transformer/anthropic/read_tool_args.go#L8-L56
  - UUID signature：https://github.com/looplj/axonhub/blob/131dc03dcbeb64d10773bc54abacec9b36b3f049/llm/transformer/anthropic/inbound_stream.go#L74-L77
  - version旁证：https://github.com/looplj/axonhub/blob/131dc03dcbeb64d10773bc54abacec9b36b3f049/llm/pipeline/cc/billing_header_test.go#L18

不会照搬AxonHub的数据库pipeline、渠道管理、模型映射、Bedrock/Vertex分支、无界Read缓冲、malformed JSON静默修复、迟到签名重复block、伪造1/1 usage或错误的provider签名启发式。