# Implementation Checklist

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
