# Implementation Plan

Build a stateless Fastify gateway that exposes Anthropic Messages and OpenAI Responses APIs,
normalizes both through a protocol-neutral representation, and calls an OpenAI-compatible
Responses upstream with a constrained Chat Completions fallback for Anthropic requests.

The implementation is delivered in independently verified slices:

1. Project foundation, configuration, health checks, and Claude Code version policy.
2. Canonical request/response/event contracts and Claude Code compatibility policies.
3. Anthropic to Responses non-streaming conversion.
4. Streaming state machines and constrained Chat fallback.
5. Responses ingress, token counting, and the Web Search provider boundary.
6. Security hardening, Docker delivery, documentation, and final review.

See `docs/compatibility.md` for the public compatibility contract and `tasks/todo.md` for the
implementation checklist.
