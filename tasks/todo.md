# Implementation Checklist

## Claude Code 流式兼容性回归修复（2026-09-11）

- [x] 固定提交差分及 Claude Code 工具结果续答 HTTP 复现
- [x] 恢复辅助内容块快照兼容，保留最终输出项校验
- [x] 补充重复快照、引用、拒答、推理和空块回归
- [x] 全量本地验证
- [x] 独立审查

根因证据：`ae74dbc` 可接受、`4dcc32f` 拒绝的内容块快照会触发同一 `The upstream stream failed` 提示。重复快照被当作新内容、预填引用重复计数及空拒答占位参与完整性校验均已复现。旧夹具曾覆盖预填引用再发送引用增量，上轮修改夹具时移除了该兼容形状；本轮使用独立原始 SSE 样本及 SDK 聚合测试覆盖。尚未取得生产原始流，不能据此认定具体触发帧。

本地验证：`pnpm test:coverage`（64 个文件、998 项测试通过；行覆盖率 96.15%，分支覆盖率 91.72%）、`pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm format:check`、`git diff --check` 均通过。原始帧 HTTP 与 SDK 回归 41 项通过；修复前的失败基线来自单元测试、HTTP 复现及固定版本差分。未增加依赖或生产诊断日志。推送目标为 `master`。

独立审查：95/100，通过，无阻断问题。代码质量 95、测试覆盖 96、规范遵循 95、可读性与可维护性 96、需求匹配 94、架构一致 96、风险可控 93、兼容性影响 95。审查代理重跑 15 类回归帧与标准基准、5 个文件的 103 项测试，以及拒答被替换和稀疏块遗漏的负面断言，全部符合预期。结论适用于已复现兼容回归，不代表已确认生产错误的唯一原因。

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
