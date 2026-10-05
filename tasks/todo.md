# Implementation Checklist

## Responses 流式收尾误报 upstream_stream_error 修复（2026-10-05）

- [x] 模拟上游复现：17 种 Chat 收尾形态中 12 种被误判为流失败
- [x] Chat 流解码以 `finish_reason` 判定结束，容忍 usage 尾帧变体与缺失的 `[DONE]`
- [x] 流身份以首帧为准，不再因尾帧改写 `id` / `model` / `created` 失败
- [x] 单元、HTTP 与 OpenAI SDK 回归，以及真实中断 / 错误帧仍输出 error 的反向用例
- [x] 兼容性文档与全量本地验证

根因：网关在 `finish_reason` 帧已关闭全部输出项（客户端看到各 `*.done` 事件），随后严格校验的 Chat 解码器在尾帧抛错，被 Responses 出口统一转换为 `upstream_stream_error`。会触发的尾帧形态包括：缺少 `data: [DONE]` 直接 EOF、`[DONE]` 后无空行、usage 帧改写或省略 `id` / `model` / `created`、usage 帧省略或置空 `choices`、携带空 delta 或重复相同 `finish_reason`。问题描述中的标准形态（空 `choices` 的 usage 帧 + `[DONE]`）修复前即可正常完成。近期提交未改动该路径（解码器最后修改于 `d88cbd8`，2026-09-14），推断为上游收尾形态变化；尚未取得生产原始流，不能确定线上具体是哪一种。

本地验证：`pnpm test:coverage`（84 个文件、1561 项测试中 1560 项通过、1 项跳过；行覆盖率 95.87%，分支覆盖率 92.11%）、`pnpm typecheck`、`pnpm build`、`pnpm lint`、`pnpm format:check`、`git diff --check` 均通过。回退源码后新增回归测试有 17 项以上失败，作为修复前基线。一次覆盖率运行中 Anthropic Read ping 计时测试偶发失败，单独重跑 3 次与再次全量运行均通过，与本次改动无关。线上 curl 验收需部署后用真实密钥执行。

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
