import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";

describe("Anthropic Web Search replay through Responses encoding", () => {
  it("preserves a replay-only assistant turn in the upstream Responses input", () => {
    const canonical = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "user", content: "search first" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_ai_hub_0",
              name: "web_search",
              input: { query: "current info" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_ai_hub_0",
              content: [],
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });

    const encoded = encodeResponsesRequest(canonical, {
      store: false,
      promptCache: { kind: "none" },
    });

    expect(encoded.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "search first" }],
      },
      { type: "message", role: "assistant", content: [] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ]);
  });
});
