import { describe, expect, it } from "vitest";
import {
  decodeAnthropicRequest,
  decodeAnthropicRequestWithSidecar,
  decodeAnthropicTokenCountRequest,
} from "../../src/protocols/anthropic/decode.js";

describe("Anthropic mid-conversation system messages", () => {
  it("decodes the Claude Code deferred-tools message shape without reordering it", () => {
    const decoded = decodeAnthropicRequest({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "system",
          content: "The following deferred tools are now available via ToolSearch.",
        },
      ],
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220;" },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [
        {
          name: "ToolSearch",
          description: "Fetch deferred tool schemas",
          input_schema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      metadata: { user_id: "opaque-session" },
      max_tokens: 64_000,
      output_config: { effort: "xhigh" },
      stream: true,
    });

    expect(decoded.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220;" },
          { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "system",
        content: [
          { type: "text", text: "The following deferred tools are now available via ToolSearch." },
        ],
      },
    ]);
    expect(decoded.reasoningEffort).toBe("xhigh");
    expect(decoded.stream).toBe(true);
  });

  it("accepts text-block arrays for mid-conversation system messages", () => {
    const decoded = decodeAnthropicRequest({
      model: "deepseek-v4-flash",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    });

    expect(decoded.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "system",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ]);
  });

  it("keeps prompt-cache positions valid with a mid-conversation system message", () => {
    const decoded = decodeAnthropicRequestWithSidecar({
      model: "deepseek-v4-flash",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: [{ type: "text", text: "deferred tools", cache_control: { type: "ephemeral" } }],
        },
      ],
    });

    expect(decoded.promptCache.input.messages).toEqual([
      { id: "message:0" },
      { id: "message:1", explicitBreakpoint: true },
    ]);
    expect(decoded.promptCache.explicitMarkers).toEqual([
      { nodeId: "message:1", marker: { type: "ephemeral" } },
    ]);
  });

  it("accepts mid-conversation system messages in token-count requests", () => {
    const decoded = decodeAnthropicTokenCountRequest({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "deferred tools" },
      ],
    });

    expect(decoded.messages.at(-1)).toEqual({
      role: "system",
      content: [{ type: "text", text: "deferred tools" }],
    });
  });
});
