import { describe, expect, it } from "vitest";
import { encodeAnthropicResponse } from "../../src/protocols/anthropic/encode.js";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";
import {
  createWebSearchReplayToken,
  createWebSearchToolUseId,
} from "../../src/providers/web-search/internal.js";

describe("Web Search replay token", () => {
  it("is stable, opaque, and does not embed the search payload", () => {
    const query = "2026年国庆节放假安排";
    const result = {
      title: "国务院办公厅通知",
      url: "https://example.test/holiday",
    };

    const first = createWebSearchReplayToken(0, 0, query, result);
    const second = createWebSearchReplayToken(0, 0, query, result);

    expect(second).toBe(first);
    expect(first).toMatch(/^ai_hub_replay_v1:[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(query);
    expect(first).not.toContain(result.title);
    expect(first).not.toContain(result.url);
  });

  it("derives distinct server-tool IDs for the same execution id in different responses", () => {
    const first = createWebSearchToolUseId("resp_turn_1", "call_search", 0);
    const second = createWebSearchToolUseId("resp_turn_2", "call_search", 0);

    expect(first).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(createWebSearchToolUseId("resp_turn_1", "call_search", 0)).toBe(first);
  });

  it("uses the same derived server-tool ID in JSON and SSE encoders", () => {
    const responseId = "msg_same";
    const executionId = "call_search";
    const query = "current info";
    const expectedId = createWebSearchToolUseId(responseId, executionId, 0);

    const json = encodeAnthropicResponse(
      {
        id: responseId,
        model: "test-model",
        content: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 0 },
      },
      {
        webSearchExecutions: [{ id: executionId, query, results: [] }],
      },
    );
    expect(json.content[0]).toMatchObject({
      type: "server_tool_use",
      id: expectedId,
      name: "web_search",
    });
    expect(json.content[1]).toMatchObject({
      type: "web_search_tool_result",
      tool_use_id: expectedId,
    });

    const stream = new AnthropicStreamEncoder({
      webSearchExecutions: [{ id: executionId, query, results: [] }],
    });
    const frames = stream.encode({ type: "response_start", id: responseId, model: "test-model" });
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "content_block_start",
        data: expect.objectContaining({
          index: 0,
          content_block: expect.objectContaining({
            type: "server_tool_use",
            id: expectedId,
            name: "web_search",
          }),
        }),
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "content_block_start",
        data: expect.objectContaining({
          index: 1,
          content_block: expect.objectContaining({
            type: "web_search_tool_result",
            tool_use_id: expectedId,
          }),
        }),
      }),
    );
  });
});
