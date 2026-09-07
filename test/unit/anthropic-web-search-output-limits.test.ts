import { describe, expect, it } from "vitest";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";

describe("Anthropic Web Search output limits", () => {
  it("charges JSON-escaped bytes for synthesized search result blocks", () => {
    const escapedTitle = '"\\\n'.repeat(1_000);
    const encoder = new AnthropicStreamEncoder({
      outputLimits: { perItemBytes: 4_500, perStreamBytes: 20_000 },
      webSearchExecutions: [
        {
          id: "call_search",
          query: "safe query",
          results: [
            {
              title: escapedTitle,
              url: "https://example.test/result",
              content: "unused by the Anthropic result block",
            },
          ],
        },
      ],
    });

    expect(() =>
      encoder.encode({ type: "response_start", id: "msg_test", model: "test-model" }),
    ).toThrowError(
      expect.objectContaining({ scope: "item", code: "STREAM_OUTPUT_TOO_LARGE" }),
    );
  });
});
