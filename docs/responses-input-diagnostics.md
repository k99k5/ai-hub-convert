# Responses 输入诊断测试分支

分支：`codex/responses-input-diagnostics`。已通过实际日志确认 Chatbox 搜索续轮在 `input[2]` 回传 `item_reference`，被网关解析器拒绝。本分支现已增加受限的 Responses 同协议引用透传，保留诊断日志供部署验证；客户端错误格式不变。

## 部署与复现

获取测试分支后重新构建，避免继续使用旧镜像：

```bash
git fetch origin
git switch codex/responses-input-diagnostics
git pull --ff-only
docker compose up -d --build gateway
docker compose logs -f --since=5m gateway
```

在 Chatbox 重试一次出现问题的 Responses 搜索请求。用错误中的 `request_id` 查找同一次请求的日志，只需提供含 `[DEBUG-responses-input-v1]` 的那一行。

本分支在 Responses 请求解码失败时输出一条 `warn` 日志：

- `request_id`：与客户端错误对应。
- `stage`：固定为 `request_decode`，表示调用上游前就拒绝了请求。
- `reason`：解析器的固定错误说明。
- `diagnostic_path`：例如 `input[4].summary[0]`；下标从 0 开始。顶层校验失败显示 `request`。
- `input_kind` / `input_count`：输入类型和输入项数量。
- `rejected_shape`：被拒绝位置的结构，包含固定字段的类型和长度；已知协议类型、角色可读，未知枚举值和自定义字段名称不会原样输出。

不会记录凭据、模型名称、prompt、工具名称及参数、工具结果正文、图片地址、reasoning 或 signature。日志大小不随对话正文长度增长；合法请求和鉴权失败不输出这条诊断。日志沿用服务的标准日志输出，不新增文件存储或环境变量。

有效引用通过解析时，会另输出一条 `info` 日志，标记为 `[DEBUG-responses-input-v1] 已接收 Responses 引用`，包含 `event:"item_reference_accepted"`、引用数量和实际采用的 `store` 值，不记录引用 ID。出现该日志说明已通过引用解析；它不表示上游已成功解析引用。如果随后仍返回错误，应结合相同 `request_id` 的 HTTP 状态检查上游是否能访问这些历史对象。

透传仅接受显式 `type:"item_reference"` 与非空字符串 `id`，保持输入顺序。不会自动开启存储，也不会在网关缓存历史；默认 `store:false`，显式 `true | false | null` 保持原值。若上游无法解析引用，需要客户端使用 `store:false` 发送完整历史，或在上游支持的前提下由调用方明确启用上游存储。

如果没有该标记，先核对是否已构建并启动测试分支；请求若在 HTTP/schema 层或上游失败，也不会进入这条诊断。

## 验证与移除

```bash
pnpm test -- test/integration/responses-diagnostics.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

使用项目指定的 pnpm 10.6.3；引用透传测试为 `test/integration/responses-item-reference.test.ts`。回滚时切回 `master` 并重新构建；正式合并引用兼容改动前移除本分支临时诊断日志，保留对应回归测试。
