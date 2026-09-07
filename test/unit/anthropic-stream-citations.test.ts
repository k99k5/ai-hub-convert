import { describe, expect, it } from "vitest";
import type { CanonicalResponse, Citation } from "../../src/core/ir.js";
import { encodeAnthropicResponse } from "../../src/protocols/anthropic/encode.js";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";

describe("Anthropic streamed citations", () => {
  it("matches JSON citations even when annotations precede the remaining text", () => {
    const text = "A 中文 answer";
    const citations: Citation[] = [
      { type: "url", url: "https://example.test/a", title: "Source", startIndex: 2, endIndex: 4 },
      { type: "url", url: "https://example.test/b" },
    ];
    const response: CanonicalResponse = {
      id: "resp_citations",
      model: "test-model",
      content: [{ type: "text", text, citations }],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    const encoder = new AnthropicStreamEncoder({
      webSearchExecutions: [{ id: "call_search", query: "test", results: [] }],
    });
    encoder.encode({ type: "response_start", id: response.id, model: response.model });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    encoder.encode({ type: "text_delta", index: 0, delta: text.slice(0, 3) });
    for (const citation of citations) {
      expect(encoder.encode({ type: "citation_delta", index: 0, citation })).toEqual([]);
    }
    encoder.encode({ type: "text_delta", index: 0, delta: text.slice(3) });
    const frames = encoder.encode({ type: "content_stop", index: 0 });
    const jsonBlock = encodeAnthropicResponse(response).content[0];
    expect(jsonBlock?.type).toBe("text");
    const expectedCitations = jsonBlock?.type === "text" ? jsonBlock.citations : undefined;
    expect(frames.slice(0, -1).map((frame) => frame.data.delta)).toEqual(
      expectedCitations?.map((citation) => ({ type: "citations_delta", citation })),
    );
    expect(frames.every((frame) => frame.data.index === 2)).toBe(true);
    expect(frames.at(-1)?.event).toBe("content_block_stop");
  });

  it("charges escaped cited text to the output limit before emitting it", () => {
    const encoder = new AnthropicStreamEncoder({
      outputLimits: { perItemBytes: 2_000, perStreamBytes: 10_000 },
    });
    encoder.encode({ type: "response_start", id: "resp_limit", model: "test-model" });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    encoder.encode({ type: "text_delta", index: 0, delta: "\n".repeat(1_000) });
    encoder.encode({
      type: "citation_delta",
      index: 0,
      citation: { type: "url", url: "https://example.test" },
    });
    expect(() => encoder.encode({ type: "content_stop", index: 0 })).toThrowError(
      expect.objectContaining({ scope: "item", code: "STREAM_OUTPUT_TOO_LARGE" }),
    );
  });

  it("rejects citation ranges beyond the final text", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_invalid", model: "test-model" });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    encoder.encode({ type: "text_delta", index: 0, delta: "short" });
    encoder.encode({
      type: "citation_delta",
      index: 0,
      citation: { type: "url", url: "https://example.test", startIndex: 0, endIndex: 100 },
    });
    expect(() => encoder.encode({ type: "content_stop", index: 0 })).toThrowError(
      expect.objectContaining({ code: "invalid_response" }),
    );
  });
});
