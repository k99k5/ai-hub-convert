import { describe, expect, it } from "vitest";
import { AnthropicStreamEncoder } from "../../src/protocols/anthropic/stream-encode.js";

const FIXED_UUID = "123e4567-e89b-42d3-a456-426614174000";
const FIXED_SIGNATURE = Buffer.from(FIXED_UUID, "utf8").toString("base64");

describe("AnthropicStreamEncoder", () => {
  it("emits a valid text, thinking, tool, and terminal lifecycle", () => {
    const encoder = new AnthropicStreamEncoder();
    const frames = [
      ...encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" }),
      ...encoder.encode({
        type: "content_start",
        index: 0,
        content: { type: "reasoning", text: "", source: "openai-responses" },
      }),
      ...encoder.encode({ type: "reasoning_delta", index: 0, delta: "plan" }),
      ...encoder.encode({ type: "signature_delta", index: 0, delta: "signature" }),
      ...encoder.encode({ type: "content_stop", index: 0 }),
      ...encoder.encode({ type: "content_start", index: 1, content: { type: "text", text: "" } }),
      ...encoder.encode({ type: "text_delta", index: 1, delta: "answer" }),
      ...encoder.encode({ type: "content_stop", index: 1 }),
      ...encoder.encode({
        type: "content_start",
        index: 2,
        content: { type: "function_call", id: "call_1", name: "Read", arguments: "" },
      }),
      ...encoder.encode({ type: "function_arguments_delta", index: 2, delta: "{}" }),
      ...encoder.encode({ type: "content_stop", index: 2 }),
      ...encoder.encode({
        type: "response_complete",
        finishReason: "tool_use",
        usage: { inputTokens: 12, outputTokens: 5, cacheReadInputTokens: 2 },
      }),
    ];

    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[0]?.data).toMatchObject({
      type: "message_start",
      message: { id: "resp_1", model: "model-a", usage: { input_tokens: 0, output_tokens: 0 } },
    });
    expect(frames[3]?.data).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signature" },
    });
    expect(frames.at(-2)?.data).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    });
    expect(frames.at(-1)?.data).toEqual({ type: "message_stop" });
  });

  it("maps canonical incomplete to the Anthropic pause_turn stop reason", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });

    expect(
      encoder.encode({
        type: "response_complete",
        finishReason: "incomplete",
        usage: { inputTokens: 2, outputTokens: 1 },
      }),
    ).toMatchObject([
      {
        event: "message_delta",
        data: { delta: { stop_reason: "pause_turn", stop_sequence: null } },
      },
      { event: "message_stop" },
    ]);
  });

  it("adds one synthetic signature before closing an unsigned thinking block", () => {
    const encoder = new AnthropicStreamEncoder({
      syntheticThinkingSignatureEnabled: true,
      uuidFactory: () => FIXED_UUID,
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      content: { type: "reasoning", text: "", source: "openai-responses" },
    });
    encoder.encode({ type: "reasoning_delta", index: 0, delta: "plan" });

    expect(encoder.encode({ type: "content_stop", index: 0 })).toEqual([
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: FIXED_SIGNATURE },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ]);
  });

  it("does not synthesize a thinking signature when the shim is disabled", () => {
    const encoder = new AnthropicStreamEncoder({ syntheticThinkingSignatureEnabled: false });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      content: { type: "reasoning", text: "", source: "openai-responses" },
    });

    expect(encoder.encode({ type: "content_stop", index: 0 })).toEqual([
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ]);
  });

  it("buffers and normalizes Read arguments while preserving interleaved tool calls", () => {
    const encoder = new AnthropicStreamEncoder({ readToolCompatEnabled: true });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      content: { type: "function_call", id: "call_0", name: "Read", arguments: "" },
    });
    encoder.encode({
      type: "content_start",
      index: 1,
      content: { type: "function_call", id: "call_1", name: "Other", arguments: "" },
    });

    expect(
      encoder.encode({
        type: "function_arguments_delta",
        index: 0,
        delta: '{"file_path":"/tmp/a",',
      }),
    ).toEqual([]);
    expect(
      encoder.encode({ type: "function_arguments_delta", index: 1, delta: '{"value":' }),
    ).toMatchObject([
      { data: { index: 1, delta: { type: "input_json_delta", partial_json: '{"value":' } } },
    ]);
    expect(
      encoder.encode({ type: "function_arguments_delta", index: 0, delta: '"pages":""}' }),
    ).toEqual([]);
    expect(
      encoder.encode({ type: "function_arguments_delta", index: 1, delta: "1}" }),
    ).toMatchObject([{ data: { index: 1, delta: { partial_json: "1}" } } }]);

    expect(encoder.encode({ type: "content_stop", index: 0 })).toEqual([
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/a"}' },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ]);
    expect(encoder.encode({ type: "content_stop", index: 1 })).toEqual([
      { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    ]);
  });

  it("bounds buffered Read arguments without buffering ordinary tools", () => {
    const encoder = new AnthropicStreamEncoder({
      readToolCompatEnabled: true,
      toolArgumentLimits: { perCallBytes: 3, perStreamBytes: 3 },
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      content: { type: "function_call", id: "call_0", name: "Read", arguments: "" },
    });
    encoder.encode({ type: "function_arguments_delta", index: 0, delta: "abc" });

    expect(() =>
      encoder.encode({
        type: "function_arguments_delta",
        index: 0,
        delta: "private-fragment",
      }),
    ).toThrowError(expect.objectContaining({ scope: "call", code: "TOOL_ARGUMENTS_TOO_LARGE" }));

    const passthrough = new AnthropicStreamEncoder({
      readToolCompatEnabled: true,
      toolArgumentLimits: { perCallBytes: 1, perStreamBytes: 1 },
    });
    passthrough.encode({ type: "response_start", id: "resp_2", model: "model-a" });
    passthrough.encode({
      type: "content_start",
      index: 0,
      content: { type: "function_call", id: "call_1", name: "Other", arguments: "" },
    });
    expect(
      passthrough.encode({ type: "function_arguments_delta", index: 0, delta: "unbuffered" }),
    ).toHaveLength(1);
  });

  it("bounds retained content block identities across the stream", () => {
    const encoder = new AnthropicStreamEncoder({
      outputLimits: { perItemBytes: 1024, perStreamBytes: 511 },
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    encoder.encode({ type: "content_stop", index: 0 });

    expect(() =>
      encoder.encode({ type: "content_start", index: 1, content: { type: "text", text: "" } }),
    ).toThrowError(expect.objectContaining({ scope: "stream", code: "STREAM_OUTPUT_TOO_LARGE" }));
  });

  it("rejects reuse of a closed content block index", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    encoder.encode({ type: "content_stop", index: 0 });

    expect(() =>
      encoder.encode({
        type: "content_start",
        index: 0,
        content: { type: "text", text: "" },
      }),
    ).toThrow(/already defined/);
  });

  it("rejects a delta before its content block starts", () => {
    const encoder = new AnthropicStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });

    expect(() => encoder.encode({ type: "text_delta", index: 0, delta: "invalid" })).toThrow(
      /not open/,
    );
  });
});
