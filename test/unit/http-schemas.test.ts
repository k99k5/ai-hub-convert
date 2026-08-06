import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  AnthropicMessagesBodySchema,
  AnthropicTokenCountBodySchema,
  OpenAIResponsesBodySchema,
} from "../../src/http/schemas.js";

describe("public route wire schemas", () => {
  it("accepts protocol objects without stripping extension fields", () => {
    const anthropic = {
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello", future_field: true }],
      system: [{ type: "text", text: "system", attribution: "future" }],
      tools: [{ type: "future_tool" }],
    };
    const responses = {
      model: "gpt-test",
      input: "hello",
      future_control: { enabled: true },
    };

    expect(Value.Check(AnthropicMessagesBodySchema, anthropic)).toBe(true);
    expect(Value.Check(OpenAIResponsesBodySchema, responses)).toBe(true);
    expect(anthropic).toHaveProperty("tools");
    expect(responses).toHaveProperty("future_control");
  });

  it("keeps message and token-count required fields distinct", () => {
    expect(
      Value.Check(AnthropicMessagesBodySchema, {
        model: "claude-test",
        max_tokens: 64,
        messages: [],
      }),
    ).toBe(true);
    expect(Value.Check(AnthropicMessagesBodySchema, { model: "claude-test", messages: [] })).toBe(
      false,
    );
    expect(Value.Check(AnthropicTokenCountBodySchema, { model: "claude-test", messages: [] })).toBe(
      true,
    );
    expect(
      Value.Check(AnthropicTokenCountBodySchema, {
        model: "claude-test",
        max_tokens: 64,
        messages: [],
      }),
    ).toBe(true);
  });

  it("rejects non-object bodies and invalid basic field types", () => {
    for (const body of [null, [], "request", 1]) {
      expect(Value.Check(AnthropicMessagesBodySchema, body)).toBe(false);
      expect(Value.Check(OpenAIResponsesBodySchema, body)).toBe(false);
    }
    expect(
      Value.Check(AnthropicMessagesBodySchema, {
        model: "claude-test",
        max_tokens: "many",
        messages: [],
      }),
    ).toBe(false);
    expect(Value.Check(OpenAIResponsesBodySchema, { model: 1 })).toBe(false);
  });
});
