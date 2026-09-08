# ADR-0001：采用不持久化数据的 canonical gateway

## 状态

已接受；保留 Responses 引用续轮所需的有界短期内存状态。

## 日期

2026-07-31

## 背景

服务需要接受 Anthropic Messages、OpenAI Responses 与 Chat Completions wire protocol，并连接一个 OpenAI-compatible 上游。服务支持 JSON/SSE、工具调用、reasoning、usage 与 citation，同时满足严格回退、零持久化和凭据透传要求。

直接在 Fastify route 中逐字段互转会把 wire validation、兼容策略、上游路由和 SSE 生命周期混在一起。直接复用 AxonHub 的 pipeline 又会引入不需要的数据库、provider/channel 管理和模型映射。

## 决策

采用以下边界：

1. 每个 public protocol 有独立 decoder/encoder；
2. decoder 先生成有序、provider-neutral canonical IR/events；
3. provider-private continuation 与 prompt-cache marker 放在受限 sidecar/opaque 类型中，不使用任意 extension bag 跨 provider 回放；
4. Claude Code 断点规划、Read 和 signature 作为 request-local compatibility policy；默认提示词缓存键独立于 Claude Code 策略，适用于三个生成入口；
5. Anthropic Messages 以 Responses 为主路径，只通过严格 classifier 进行一次 Chat fallback；Chat 对外入口直接请求上游 Chat，不回退或重试；
6. Web Search 通过独立 provider registry 扩展，unsupported provider 在路由预检阶段返回 501；
7. 所有上游路径为代码中的固定枚举，URL 只来自启动配置；
8. 不使用数据库、持久化 session 或本地 token estimate；提示词缓存交由上游处理。为兼容 Chatbox 1.21.1，允许在进程内短期缓存成功 Responses 输出项，用于展开后续 `item_reference`，不缓存请求 prompt、整段历史或 API key 原文。

Chat 入口复用 canonical IR/events，协议专有字段仅通过受限同协议扩展保存。三个生成入口共用已验证的 prompt_cache_key 字段；默认生成键的规则及 Chat 支持范围以[兼容性契约](../compatibility.md)为准。上游支持该字段是部署前提，不增加缓存配置或删字段重试路径。

Responses 引用在调用上游前按输入顺序展开为完整内容，再复用现有协议转换。输出项缓存按凭据 HMAC 散列和请求模型隔离，具有固定有效期、字节预算和条目上限，不写磁盘，不引入依赖或环境变量。只在 JSON/SSE 完整校验成功后写入；缺失、过期、淘汰或冲突的引用明确拒绝，不能静默丢弃历史或透传给不支持引用的上游。预算、清理和错误契约统一定义在[Responses 引用缓存](../compatibility.md#responses-引用缓存)。

## 备选方案

### Route 中直接互转

优点是初始文件少。缺点是 JSON/SSE 很快形成两套语义，fallback 也难以证明发生在零语义事件和零客户端写入之前。拒绝。

### 透明代理 Responses

无法执行 public Responses 的完整 normalization，也无法统一错误清洗、stream validation、限制和 citation/reasoning 行为。拒绝。

### 复制 AxonHub pipeline

它提供了 IR/adapter 的参考，但数据库 pipeline、provider 管理、channel、模型映射和多云分支超出本项目范围，会破坏零持久化目标。拒绝。

### 将 Responses 引用透传给上游

目标上游不能保证解析 `item_reference`。单纯接受并透传该字段不能完成 Chatbox 续轮，删除未命中引用又会丢失历史。采用仅缓存成功输出项的有界内存例外，在网关展开引用；不建设完整会话存储，也不把 `previous_response_id` 变成会话重建接口。

### Anthropic 默认走 Chat

Chat 对 reasoning continuation、Responses item/event 和 citation 的表达更弱，也无法满足用户确认的 Responses 主路径。拒绝。

## 后果

- JSON 与 SSE 能共享 canonical 语义和兼容策略；
- fallback 边界可由状态机和测试精确证明；
- provider-private 字段只在来源协议和结构允许时回放；
- 新增一种 wire event 可能需要同时更新 canonical event union 与两个 stream encoder；
- 上游默认支持用户确认的 prompt_cache_key，不假定 Anthropic 断点和 TTL 的等价语义；
- 服务不再承诺完全无状态，但仍不持久化数据；Responses 引用缓存与上游提示词缓存相互独立；
- 引用缓存不跨进程共享，重启后旧引用失效；部署需使用单实例或粘性路由，客户端也可通过 `store:false` 回传完整历史；
- 未来主动 Web Search 供应商需实现 registry contract，并继续遵守启动配置 URL 与日志保密约束。
