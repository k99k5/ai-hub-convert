# ADR-0001：采用无状态 canonical gateway

## 状态

Accepted

## 日期

2026-07-31

## 背景

服务需要同时接受 Anthropic Messages 与 OpenAI Responses wire protocol，并连接一个 generic OpenAI-compatible 上游。首版必须支持 JSON/SSE、工具调用、reasoning、usage 与 citation，同时满足严格回退、零持久化和凭据透传要求。

直接在 Fastify route 中逐字段互转会把 wire validation、兼容策略、上游路由和 SSE 生命周期混在一起。直接复用 AxonHub 的 pipeline 又会引入不需要的数据库、provider/channel 管理和模型映射。

## 决策

采用以下边界：

1. 每个 public protocol 有独立 decoder/encoder；
2. decoder 先生成有序、provider-neutral canonical IR/events；
3. provider-private continuation 与 prompt-cache marker 放在受限 sidecar/opaque 类型中，不使用任意 extension bag 跨 provider 回放；
4. Claude Code cache、Read 和 signature 作为 request-local compatibility policy；
5. Anthropic Messages 以 Responses 为主路径，只通过严格 classifier 进行一次 Chat fallback；
6. Web Search 通过独立 provider registry 扩展，unsupported provider 在路由预检阶段返回 501；
7. 所有上游路径为代码中的固定枚举，URL 只来自启动配置；
8. 不使用数据库、session 或本地 token estimate。

## 备选方案

### Route 中直接互转

优点是初始文件少。缺点是 JSON/SSE 很快形成两套语义，fallback 也难以证明发生在零语义事件和零客户端写入之前。拒绝。

### 透明代理 Responses

无法执行 public Responses 的完整 normalization，也无法统一错误清洗、stream validation、限制和 citation/reasoning 行为。拒绝。

### 复制 AxonHub pipeline

它提供了 IR/adapter 的参考，但数据库 pipeline、provider 管理、channel、模型映射和多云分支超出本项目范围，会破坏无状态目标。拒绝。

### Anthropic 默认走 Chat

Chat 对 reasoning continuation、Responses item/event 和 citation 的表达更弱，也无法满足用户确认的 Responses 主路径。拒绝。

## 后果

- JSON 与 SSE 能共享 canonical 语义和兼容策略；
- fallback 边界可由状态机和测试精确证明；
- provider-private 字段只在来源协议和结构允许时回放；
- 新增一种 wire event 可能需要同时更新 canonical event union 与两个 stream encoder；
- generic provider 默认保守，未知 capability 不会被猜测；
- 未来主动 Web Search 供应商需实现 registry contract，并继续遵守启动配置 URL 与日志保密约束。
