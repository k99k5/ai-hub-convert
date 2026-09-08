# Responses 输入诊断测试分支

分支：`codex/responses-input-diagnostics`。已通过实际日志确认 Chatbox 搜索续轮回传 `item_reference`。为兼容 Chatbox 1.21.1，本分支使用按凭据和请求模型隔离的短期内存缓存，在网关展开成功 Responses 输出项的引用，不依赖上游支持引用。保留临时诊断日志供测试分支部署验证；客户端仍使用 OpenAI 错误格式，无法展开引用时返回 HTTP 400 `reference_cache_miss`。

## 部署与复现

获取测试分支后重新构建，避免继续使用旧镜像：

```bash
git fetch origin
git switch codex/responses-input-diagnostics
git pull --ff-only
docker compose up -d --build gateway
docker compose logs -f --since=5m gateway
```

部署后在 Chatbox 新建会话，再执行一次 Responses 搜索及续轮；旧进程产生的引用不能在新进程使用。发生错误时，用错误中的 `request_id` 查找同一次请求的日志，只需提供含 `[DEBUG-responses-input-v1]` 的那一行。

本分支在 Responses 请求解码失败时输出一条 `warn` 日志：

- `request_id`：与客户端错误对应。
- `stage`：固定为 `request_decode`，表示调用上游前就拒绝了请求。
- `reason`：解析器的固定错误说明。
- `diagnostic_path`：例如 `input[4].summary[0]`；下标从 0 开始。顶层校验失败显示 `request`。
- `input_kind` / `input_count`：输入类型和输入项数量。
- `rejected_shape`：被拒绝位置的结构，包含固定字段的类型和长度；已知协议类型、角色可读，未知枚举值和自定义字段名称不会原样输出。

不会记录凭据、模型名称、prompt、工具名称及参数、工具结果正文、图片地址、reasoning、signature、引用 ID 或输出项 ID。`request_id` 仅用于关联当前请求。日志大小不随对话正文长度增长；合法请求和鉴权失败不输出这条输入校验诊断。日志沿用服务的标准日志输出，不新增文件存储或环境变量。

有效引用展开后，会另输出一条 `info` 日志，标记为 `[DEBUG-responses-input-v1] 已从内存展开 Responses 引用`，包含 `event:"item_reference_resolved"`、引用数量和实际采用的 `store` 值，不记录引用 ID。这是网关引用处理诊断，不表示上游已成功生成回答；上游接收的是展开后的完整内容。如果随后仍返回错误，应结合相同 `request_id` 的 HTTP 状态区分本地引用未命中与上游处理失败。

后续 JSON/SSE 处理失败时输出 `[DEBUG-responses-input-v1] Responses 后续处理失败`：`stage:"upstream_http"` 表示确实收到上游非成功 HTTP 状态，`upstream_status` 是原状态，`upstream_code` 仅输出白名单值，其他值统一为 `unrecognized` 或 `absent`。`reference_hint` 根据有限错误码或英文错误文本特征归类为 `item_not_found`、`item_reference_unsupported`、`tool_call_not_found` 或 `unknown`；它是定位线索，不是对上游存储状态的证明。非 HTTP 错误标为 `gateway_processing`。不记录原始错误正文、请求 ID 响应头或未知错误码；客户端仍收到原有清洗后的错误。

引用只接受显式 `type:"item_reference"` 与非空字符串 `id`，按原顺序展开；未命中引用不透传、不丢弃。只有完整校验成功的 Responses 输出项会在进程内短期缓存，不缓存请求 prompt 或整段历史，不写磁盘。默认 `store:false`，显式 `true | false | null` 保持原值，不因引用自动开启上游存储。有效期、容量预算和隔离规则以[引用兼容契约](compatibility.md#responses-引用缓存)为准。

出现 `reference_cache_miss` 时，检查是否刚重启、切换了调用凭据或请求模型、超过缓存有效期，或由负载均衡分发到了另一实例。淘汰、超大输出项未缓存及同 ID 冲突也会使引用不可用。新建会话可以重新建立当前进程的输出项缓存；也可让客户端使用 `store:false` 发送完整历史。多实例场景需粘性路由，不能依赖当前实现跨实例共享历史。

如果没有该标记，先核对是否已构建并启动测试分支；请求若在 HTTP/schema 层或上游失败，也不会进入这条诊断。

## 验证与移除

```bash
pnpm test -- test/integration/responses-diagnostics.test.ts test/integration/responses-item-reference.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

使用项目指定的 pnpm 10.6.3。测试应覆盖引用的 JSON/SSE 续轮、完整输出重放、过期与淘汰、凭据及模型隔离、失败响应不写入，以及安全错误和诊断日志。回滚时切回 `master` 并重新构建，旧内存引用随进程退出失效；正式合并引用兼容改动前移除本分支临时诊断日志，保留对应回归测试。
