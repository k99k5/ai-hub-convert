# Responses 输入诊断测试分支

分支：`codex/responses-input-diagnostics`。用途是定位 Chatbox 搜索续轮的 `Unsupported OpenAI Responses input`；尚未确认实际触发原因，本分支不改变请求接受规则或客户端错误格式。

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

如果没有该标记，先核对是否已构建并启动测试分支；请求若在 HTTP/schema 层或上游失败，也不会进入这条诊断。

## 验证与移除

```bash
pnpm test -- test/integration/responses-diagnostics.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

使用项目指定的 pnpm 10.6.3。诊断结束后切回 `master` 并重新构建；根因修复只保留对应回归测试，不把本分支临时日志长期合入正式版本。
