import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import type { AnthropicMessageRequest } from "../../src/protocols/anthropic/types.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { encodeResponsesInputTokensRequest } from "../../src/protocols/openai-responses/input-tokens.js";

const schema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["answer"],
  additionalProperties: false,
};

describe("Anthropic structured output conversion", () => {
  it("decodes output_config.format and maps it to Responses, token counting, and Chat", () => {
    const request: AnthropicMessageRequest = {
      model: "test-model",
      max_tokens: 65000,
      messages: [{ role: "user", content: "return json" }],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema },
      },
      stream: true,
    };
    const decoded = decodeAnthropicRequest(request);

    expect(decoded.reasoningEffort).toBe("high");
    expect(decoded.outputFormat).toEqual({ type: "json_schema", schema });

    const expectedTextFormat = {
      format: {
        type: "json_schema" as const,
        name: "response",
        schema,
        strict: true as const,
      },
    };

    const responses = encodeResponsesRequest(decoded, {
      store: false,
      promptCache: { kind: "none" },
    });
    expect(responses.text).toEqual(expectedTextFormat);

    const inputTokens = encodeResponsesInputTokensRequest(decoded);
    expect(inputTokens.text).toEqual(expectedTextFormat);

    const chat = encodeChatRequest(decoded);
    expect(chat.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema,
      },
    });
  });

  it("still rejects malformed output formats", () => {
    for (const format of [
      { type: "json_schema" },
      { type: "json_object", schema },
      { type: "json_schema", schema: [] },
      { type: "json_schema", schema, unknown: true },
    ]) {
      expect(() =>
        decodeAnthropicRequest({
          model: "test-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "x" }],
          output_config: { format },
        }),
      ).toThrowError();
    }
  });
});
