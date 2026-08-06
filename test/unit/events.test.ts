import { describe, expect, it } from "vitest";
import { foldCanonicalEvents, type CanonicalEvent } from "../../src/core/events.js";

describe("foldCanonicalEvents", () => {
  it("folds ordered text, reasoning, tool arguments, citations, and terminal usage", () => {
    const events: CanonicalEvent[] = [
      { type: "response_start", id: "resp_1", model: "model-a" },
      {
        type: "content_start",
        index: 0,
        content: { type: "reasoning", text: "", source: "openai-responses" },
      },
      { type: "reasoning_delta", index: 0, delta: "plan" },
      { type: "signature_delta", index: 0, delta: "opaque" },
      { type: "content_stop", index: 0 },
      { type: "content_start", index: 1, content: { type: "text", text: "" } },
      { type: "text_delta", index: 1, delta: "answer" },
      {
        type: "citation_delta",
        index: 1,
        citation: { type: "url", url: "https://example.test", title: "Source" },
      },
      { type: "content_stop", index: 1 },
      {
        type: "content_start",
        index: 2,
        content: { type: "function_call", id: "call_1", name: "Read", arguments: "" },
      },
      { type: "function_arguments_delta", index: 2, delta: '{"file_path":"/tmp/a"}' },
      { type: "content_stop", index: 2 },
      {
        type: "response_complete",
        finishReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
      },
    ];

    expect(foldCanonicalEvents(events)).toEqual({
      id: "resp_1",
      model: "model-a",
      content: [
        {
          type: "reasoning",
          text: "plan",
          signature: "opaque",
          source: "openai-responses",
        },
        {
          type: "text",
          text: "answer",
          citations: [{ type: "url", url: "https://example.test", title: "Source" }],
        },
        {
          type: "function_call",
          id: "call_1",
          name: "Read",
          arguments: '{"file_path":"/tmp/a"}',
        },
      ],
      finishReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 },
    });
  });

  it("rejects an incomplete event stream", () => {
    expect(() =>
      foldCanonicalEvents([{ type: "response_start", id: "resp_1", model: "model-a" }]),
    ).toThrow(/incomplete/);
  });
});
