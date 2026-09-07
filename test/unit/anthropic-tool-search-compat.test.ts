import { describe, expect, it } from "vitest";
import {
  AnthropicDecodeError,
  decodeAnthropicRequest,
  decodeAnthropicRequestWithSidecar,
  decodeAnthropicTokenCountRequest,
} from "../../src/protocols/anthropic/decode.js";

const toolSearchVariants = [
  ["tool_search_tool_regex_20251119", "tool_search_tool_regex"],
  ["tool_search_tool_regex", "tool_search_tool_regex"],
  ["tool_search_tool_bm25_20251119", "tool_search_tool_bm25"],
  ["tool_search_tool_bm25", "tool_search_tool_bm25"],
] as const;

describe("Anthropic Tool Search compatibility", () => {
  it.each(
    toolSearchVariants,
  )("drops %s while keeping deferred function tools resident", (type, name) => {
    const decoded = decodeAnthropicRequest({
      model: "deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type, name },
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
          defer_loading: true,
        },
      ],
    });

    expect(decoded.tools).toEqual([
      {
        type: "function",
        name: "Read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
        strict: false,
      },
    ]);
  });

  it.each(
    toolSearchVariants,
  )("promotes deferred Claude Code WebSearch to gateway-owned Web Search for %s", (type, name) => {
    const decoded = decodeAnthropicRequest({
      model: "deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "search" }],
      tools: [
        { type, name },
        {
          name: "WebSearch",
          description: "Search the web",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          defer_loading: true,
        },
      ],
    });

    expect(decoded.tools).toEqual([
      {
        type: "web_search",
        provider: "web-search",
        version: "web_search_20250305",
      },
    ]);
  });

  it("keeps prompt-cache tool positions aligned after dropping Tool Search", () => {
    const decoded = decodeAnthropicRequestWithSidecar({
      model: "deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
        {
          name: "Read",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
          defer_loading: true,
        },
      ],
    });

    expect(decoded.request.tools).toHaveLength(1);
    expect(decoded.promptCache.input.tools).toEqual([{ id: "tool:0", explicitBreakpoint: true }]);
    expect(decoded.promptCache.explicitMarkers).toEqual([
      { nodeId: "tool:0", marker: { type: "ephemeral" } },
    ]);
  });

  it("applies the same compatibility rule to token counting", () => {
    const decoded = decodeAnthropicTokenCountRequest({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
        { name: "Bash", input_schema: { type: "object" }, defer_loading: true },
      ],
    });

    expect(decoded.tools).toEqual([
      {
        type: "function",
        name: "Bash",
        inputSchema: { type: "object" },
        strict: false,
      },
    ]);
  });

  it("rejects malformed Tool Search declarations", () => {
    expect(() =>
      decodeAnthropicRequest({
        model: "deepseek-v4-flash",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "tool_search_tool_regex_20251119",
            name: "tool_search_tool_bm25",
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);
  });
});
