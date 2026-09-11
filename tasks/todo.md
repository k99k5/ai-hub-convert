# Implementation Checklist

## 协议转换缺口修复（2026-09-11）

- [x] Responses 结构化输出和文本配置
- [x] 流式未完成工具参数及输出项状态
- [x] 多文本块引用索引与位置
- [x] 图片精度参数
- [x] 函数 strict 缺省和 null
- [x] 工具执行失败标记
- [x] 混合历史内容顺序
- [x] Anthropic 搜索位置
- [x] 回归测试、全量本地验证与兼容文档
- [x] 独立审查

本地验证：`pnpm test:coverage`（63 个文件、955 项测试通过；行覆盖率 96.15%，分支覆盖率 91.61%）、`pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm format:check`、`git diff --check` 均通过。回归命令与兼容性说明见 [兼容性契约](../docs/compatibility.md)。

独立审查结论：通过，综合 95/100，无阻断问题。代码质量 95、测试覆盖 96、规范遵循 94、可读性与可维护性 94；需求匹配 97、架构一致 95、风险可控 94、兼容性影响 95。审查代理独立复跑新增 111 项测试及旧流式兼容用例；真实上游模型与搜索服务的在线可用性未纳入本地验证。环境未提供 opus，审查使用可用的继承模型完成。

- [x] Foundation, Node 24 / pnpm 10.6.3 configuration, health checks, and version policy
- [x] Canonical IR/events and Claude Code compatibility policies
- [x] Anthropic, Responses, and Chat non-streaming adapters
- [x] SSE state machines, bounded buffers, cancellation, ping, and constrained fallback
- [x] Responses ingress, exact token counting, and Web Search provider boundary
- [x] Prompt-cache sidecar/planner and conservative generic provider capability
- [x] Responses reasoning continuation, done-item consistency, and citation/tool SSE parity
- [x] Real client disconnect AbortSignal propagation
- [x] Docker, environment example, README, compatibility contract, and ADR
- [x] Fastify TypeBox route schemas and protocol-native 400/413 mapping
- [x] Per-frame, per-item, aggregate-output, and tool-argument stream limits
- [x] Coverage threshold and production dependency audit
- [ ] Docker build, health, non-root, and graceful-stop smoke tests (`docker` unavailable in this environment)
- [x] Final independent code/security/simplification review
