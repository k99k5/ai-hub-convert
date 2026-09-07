import { describe, expect, it } from "vitest";
import { encodeAnthropicResponse } from "../../src/protocols/anthropic/encode.js";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import type { WebSearchProvider } from "../../src/providers/web-search/types.js";
import { UpstreamClient } from "../../src/upstream/client.js";
import { getWebSearchRequestCount } from "../../src/upstream/web-search-loop.js";

describe("Web Search usage reporting", () => {
  it("counts an executed search even when the provider returns zero results", async () => {
    const responses = [
      {
        id: "resp_search",
        model: "test-model",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "call_search",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            arguments: JSON.stringify({ query: "2026 national day weekday" }),
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      {
        id: "resp_final",
        model: "test-model",
        status: "completed",
        output: [],
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    ];
    const provider: WebSearchProvider = {
      capabilities: () => ({ execute: true, citations: false, streaming: false }),
      execute: async () => [],
    };
    const client = new UpstreamClient({
      baseUrl: new URL("https://upstream.example/v1/"),
      timeoutMs: 1_000,
      webSearchProvider: provider,
      fetch: async () => {
        const body = responses.shift();
        if (body === undefined) {
          throw new Error("Unexpected upstream request");
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await client.postJson(
      "responses",
      {
        stream: false,
        input: [],
        tools: [
          {
            type: "function",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            parameters: { type: "object" },
          },
        ],
      },
      "test-key",
      new AbortController().signal,
    );

    expect(getWebSearchRequestCount(result)).toBe(1);
  });

  it("emits server_tool_use.web_search_requests in non-streaming Anthropic usage", () => {
    const response = encodeAnthropicResponse({
      id: "msg_test",
      model: "test-model",
      content: [{ type: "text", text: "done" }],
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },
    });

    expect(response.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  it("emits server_tool_use.web_search_requests in streaming Anthropic usage", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "msg_test", model: "test-model" });
    const frames = encoder.encode({
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 2 },
    });

    expect(frames[0]?.data.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      server_tool_use: { web_search_requests: 2 },
    });
  });
});
