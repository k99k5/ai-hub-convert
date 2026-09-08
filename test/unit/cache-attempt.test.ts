import { describe, expect, it } from "vitest";
import type { CanonicalRequest } from "../../src/core/ir.js";
import {
  GENERIC_PROMPT_CACHE_CAPABILITIES,
  type PromptCacheCapability,
} from "../../src/policies/cache/capabilities.js";
import { preparePromptCacheAttempt } from "../../src/policies/cache/attempt.js";
import type { PromptCacheSidecar } from "../../src/policies/cache/sidecar.js";

const request: CanonicalRequest = {
  source: "anthropic",
  model: "test-model",
  messages: [
    { role: "system", content: [{ type: "text", text: "system" }] },
    { role: "user", content: [{ type: "text", text: "history" }] },
    { role: "user", content: [{ type: "text", text: "tail" }] },
  ],
  tools: [
    {
      type: "function",
      name: "weather",
      inputSchema: { type: "object" },
      strict: false,
    },
  ],
  stream: false,
};

const sidecar: PromptCacheSidecar = {
  input: {
    tools: [{ id: "tool:0", explicitBreakpoint: true }],
    system: [{ id: "system:0" }],
    messages: [{ id: "message:0" }, { id: "message:1" }],
  },
  explicitMarkers: [{ nodeId: "tool:0", marker: { type: "ephemeral", ttl: "5m" } }],
};

const blockCapability: PromptCacheCapability = {
  kind: "block-breakpoints",
  maxBreakpoints: 4,
  sections: ["tools", "system", "messages"],
};

describe("preparePromptCacheAttempt", () => {
  it("两条上游路径默认支持提示词缓存键", () => {
    expect(GENERIC_PROMPT_CACHE_CAPABILITIES).toEqual({
      responses: { kind: "prompt-cache-key" },
      chatCompletions: { kind: "prompt-cache-key" },
    });
  });

  it("does not plan or encode when the current provider capability is none", () => {
    expect(
      preparePromptCacheAttempt({
        request,
        sidecar,
        enabled: true,
        operation: "completion",
        capability: { kind: "none" },
      }),
    ).toEqual({ planned: [], encoded: [] });
  });

  it("plans per completion attempt but never claims unsupported markers were encoded", () => {
    expect(
      preparePromptCacheAttempt({
        request,
        sidecar,
        enabled: true,
        operation: "completion",
        capability: blockCapability,
      }),
    ).toEqual({
      planned: [
        {
          nodeId: "tool:0",
          source: "explicit",
          section: "tools",
          reason: "explicit breakpoint",
        },
        {
          nodeId: "system:0",
          source: "automatic",
          section: "system",
          reason: "last system block",
        },
        {
          nodeId: "message:0",
          source: "automatic",
          section: "messages",
          reason: "historical message boundary",
        },
      ],
      encoded: [],
    });
  });

  it("never plans or encodes cache writes for token counting", () => {
    expect(
      preparePromptCacheAttempt({
        request,
        sidecar,
        enabled: true,
        operation: "count_tokens",
        capability: blockCapability,
      }),
    ).toEqual({ planned: [], encoded: [] });
  });

  it("requires the Claude Code policy gate even for a cache-capable provider", () => {
    expect(
      preparePromptCacheAttempt({
        request,
        sidecar,
        enabled: false,
        operation: "completion",
        capability: blockCapability,
      }),
    ).toEqual({ planned: [], encoded: [] });
  });
});
