import { describe, expect, it } from "vitest";
import { encodeAnthropicResponse } from "../../src/protocols/anthropic/encode.js";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";
import {
  createWebSearchReplayToken,
  createWebSearchToolUseId,
  INTERNAL_WEB_SEARCH_TOOL_NAME,
} from "../../src/providers/web-search/internal.js";
import type { WebSearchProvider } from "../../src/providers/web-search/types.js";
import { UpstreamClient } from "../../src/upstream/client.js";
import {
  decodeWebSearchExecutionsHeader,
  getWebSearchRequestCount,
} from "../../src/upstream/web-search-loop.js";

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

  it("carries real web search query and results into synthesized stream metadata", async () => {
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
            arguments: JSON.stringify({ query: "2026年10月1日 国庆节 星期几" }),
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
      execute: async () => [
        {
          title: "2026年国庆节",
          url: "https://example.com/national-day",
          content: "2026年10月1日是星期四。",
        },
      ],
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

    const stream = await client.postStream(
      "responses",
      {
        stream: true,
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

    expect(
      decodeWebSearchExecutionsHeader(stream.headers.get("x-ai-hub-web-search-trace")),
    ).toEqual([
      {
        id: "call_search",
        query: "2026年10月1日 国庆节 星期几",
        results: [
          {
            title: "2026年国庆节",
            url: "https://example.com/national-day",
            content: "2026年10月1日是星期四。",
          },
        ],
      },
    ]);
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

  it("emits replayable encrypted_content in non-streaming Anthropic Web Search results", () => {
    const query = "2026年10月1日 国庆节 星期几";
    const result = {
      title: "2026年国庆节",
      url: "https://example.com/national-day",
    };
    const expectedReplayToken = createWebSearchReplayToken(0, 0, query, result);
    const response = encodeAnthropicResponse(
      {
        id: "msg_test",
        model: "test-model",
        content: [{ type: "text", text: "done" }],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },
      },
      { webSearchExecutions: [{ id: "call_search", query, results: [result] }] },
    );

    expect(response.content[1]).toMatchObject({
      type: "web_search_tool_result",
      content: [
        {
          type: "web_search_result",
          title: result.title,
          url: result.url,
          encrypted_content: expectedReplayToken,
        },
      ],
    });
  });

  it("emits server_tool_use.web_search_requests in streaming Anthropic usage", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "msg_test", model: "test-model" });
    const frames = encoder.encode({
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 2 },
    });

    const messageDelta = frames.find((frame) => frame.event === "message_delta");
    expect(messageDelta?.data.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      server_tool_use: { web_search_requests: 2 },
    });
  });

  it("emits native Anthropic web search blocks before final answer content", () => {
    const encoder = new AnthropicStreamEncoder({
      webSearchExecutions: [
        {
          id: "call_search",
          query: "2026年10月1日 国庆节 星期几",
          results: [
            {
              title: "2026年国庆节",
              url: "https://example.com/national-day",
              content: "2026年10月1日是星期四。",
            },
          ],
        },
      ],
    });
    const frames = [
      ...encoder.encode({ type: "response_start", id: "msg_test", model: "test-model" }),
      ...encoder.encode({
        type: "content_start",
        index: 0,
        content: { type: "text", text: "" },
      }),
      ...encoder.encode({ type: "text_delta", index: 0, delta: "final answer" }),
      ...encoder.encode({ type: "content_stop", index: 0 }),
      ...encoder.encode({
        type: "response_complete",
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },
      }),
    ];

    const expectedToolUseId = createWebSearchToolUseId("msg_test", "call_search", 0);
    expect(frames).toContainEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "server_tool_use",
          id: expectedToolUseId,
          name: "web_search",
          input: {},
        },
      },
    });
    expect(frames).toContainEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ query: "2026年10月1日 国庆节 星期几" }),
        },
      },
    });
    expect(frames).toContainEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: expectedToolUseId,
          content: [
            {
              type: "web_search_result",
              title: "2026年国庆节",
              url: "https://example.com/national-day",
              encrypted_content: createWebSearchReplayToken(0, 0, "2026年10月1日 国庆节 星期几", {
                title: "2026年国庆节",
                url: "https://example.com/national-day",
              }),
            },
          ],
        },
      },
    });

    const searchStart = frames.findIndex(
      (frame) =>
        frame.event === "content_block_start" &&
        (frame.data.content_block as { type?: string } | undefined)?.type === "server_tool_use",
    );
    const answerStart = frames.findIndex(
      (frame) =>
        frame.event === "content_block_start" &&
        (frame.data.content_block as { type?: string } | undefined)?.type === "text",
    );
    expect(searchStart).toBeGreaterThanOrEqual(0);
    expect(answerStart).toBeGreaterThan(searchStart);
    expect(frames[answerStart]?.data.index).toBe(2);
  });
});
