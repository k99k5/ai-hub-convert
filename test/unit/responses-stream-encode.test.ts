import { describe, expect, it } from "vitest";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";

describe("ResponsesStreamEncoder", () => {
  it("rebuilds a normalized text stream with stable item IDs and terminal output", () => {
    const encoder = new ResponsesStreamEncoder();
    const frames = [
      ...encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" }),
      ...encoder.encode({
        type: "content_start",
        index: 0,
        itemId: "msg_1",
        content: { type: "text", text: "" },
      }),
      ...encoder.encode({ type: "text_delta", index: 0, delta: "hello" }),
      ...encoder.encode({
        type: "citation_delta",
        index: 0,
        citation: {
          type: "url",
          url: "https://example.test/source",
          title: "Source",
          startIndex: 0,
          endIndex: 5,
        },
      }),
      ...encoder.encode({ type: "content_stop", index: 0 }),
      ...encoder.encode({
        type: "response_complete",
        finishReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 2 },
      }),
    ];

    expect(frames.map((frame) => frame.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.annotation.added",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames.map((frame) => frame.data.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frames[3]?.data).toMatchObject({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hello",
      logprobs: [],
    });
    expect(frames[4]?.data).toMatchObject({
      type: "response.output_text.annotation.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      annotation_index: 0,
      annotation: {
        type: "url_citation",
        url: "https://example.test/source",
        title: "Source",
        start_index: 0,
        end_index: 5,
      },
    });
    expect(frames.at(-1)?.data).toMatchObject({
      type: "response.completed",
      response: {
        id: "resp_1",
        object: "response",
        model: "model-a",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "hello",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "Source",
                    start_index: 0,
                    end_index: 5,
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    });
  });

  it("rebuilds reasoning and interleaved function calls without synthetic signatures", () => {
    const encoder = new ResponsesStreamEncoder();
    const frames = [
      ...encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" }),
      ...encoder.encode({
        type: "content_start",
        index: 0,
        itemId: "rs_1",
        content: {
          type: "reasoning",
          text: "",
          source: "openai-responses",
          opaque: {
            provider: "openai-responses",
            kind: "reasoning",
            value: "encrypted-real",
          },
        },
      }),
      ...encoder.encode({ type: "reasoning_delta", index: 0, delta: "plan" }),
      ...encoder.encode({ type: "content_stop", index: 0 }),
      ...encoder.encode({
        type: "content_start",
        index: 1,
        itemId: "fc_1",
        content: { type: "function_call", id: "call_1", name: "first", arguments: "" },
      }),
      ...encoder.encode({
        type: "content_start",
        index: 2,
        itemId: "fc_2",
        content: { type: "function_call", id: "call_2", name: "second", arguments: "" },
      }),
      ...encoder.encode({ type: "function_arguments_delta", index: 1, delta: '{"a":' }),
      ...encoder.encode({ type: "function_arguments_delta", index: 2, delta: '{"b":2}' }),
      ...encoder.encode({ type: "function_arguments_delta", index: 1, delta: "1}" }),
      ...encoder.encode({ type: "content_stop", index: 2 }),
      ...encoder.encode({ type: "content_stop", index: 1 }),
      ...encoder.encode({
        type: "response_complete",
        finishReason: "tool_use",
        usage: { inputTokens: 8, outputTokens: 5, reasoningTokens: 2 },
      }),
    ];

    expect(frames.map((frame) => frame.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(frames).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ type: "response.reasoning_summary_text.signature" }),
        }),
      ]),
    );
    expect(frames.at(-1)?.data).toMatchObject({
      response: {
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            status: "completed",
            summary: [{ type: "summary_text", text: "plan" }],
            encrypted_content: "encrypted-real",
          },
          {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "first",
            arguments: '{"a":1}',
            status: "completed",
          },
          {
            id: "fc_2",
            type: "function_call",
            call_id: "call_2",
            name: "second",
            arguments: '{"b":2}',
            status: "completed",
          },
        ],
      },
    });
  });

  it("replays a streamed reasoning continuation only for its open Responses item", () => {
    const encoder = new ResponsesStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      itemId: "rs_1",
      content: { type: "reasoning", text: "", source: "openai-responses" },
    });
    encoder.encode({ type: "reasoning_delta", index: 0, delta: "plan" });
    expect(
      encoder.encode({
        type: "reasoning_continuation",
        index: 0,
        opaque: {
          provider: "openai-responses",
          kind: "reasoning",
          value: "encrypted-real",
        },
      }),
    ).toEqual([]);

    expect(encoder.encode({ type: "content_stop", index: 0 })).toContainEqual(
      expect.objectContaining({
        event: "response.output_item.done",
        data: expect.objectContaining({
          item: expect.objectContaining({ encrypted_content: "encrypted-real" }),
        }),
      }),
    );
  });

  it("rejects buffered function arguments that exceed configured byte limits", () => {
    const encoder = new ResponsesStreamEncoder({ perCallBytes: 3, perStreamBytes: 3 });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      itemId: "fc_1",
      content: { type: "function_call", id: "call_1", name: "limited", arguments: "" },
    });
    encoder.encode({ type: "function_arguments_delta", index: 0, delta: "abc" });

    expect(() =>
      encoder.encode({ type: "function_arguments_delta", index: 0, delta: "private-fragment" }),
    ).toThrowError(expect.objectContaining({ scope: "call", code: "TOOL_ARGUMENTS_TOO_LARGE" }));
  });

  it("rejects text or reasoning that exceeds the per-item output budget", () => {
    for (const type of ["text", "reasoning"] as const) {
      const encoder = new ResponsesStreamEncoder(undefined, {
        perItemBytes: 265,
        perStreamBytes: 1_000,
      });
      encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
      encoder.encode({
        type: "content_start",
        index: 0,
        itemId: "item_1",
        content:
          type === "text"
            ? { type: "text", text: "" }
            : { type: "reasoning", text: "", source: "openai-responses" },
      });
      encoder.encode({
        type: type === "text" ? "text_delta" : "reasoning_delta",
        index: 0,
        delta: "abc",
      });

      expect(() =>
        encoder.encode({
          type: type === "text" ? "text_delta" : "reasoning_delta",
          index: 0,
          delta: "private-fragment",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "STREAM_OUTPUT_TOO_LARGE",
          scope: "item",
          limitBytes: 265,
        }),
      );
    }
  });

  it("rejects aggregate output across many individually bounded items", () => {
    const encoder = new ResponsesStreamEncoder(undefined, {
      perItemBytes: 300,
      perStreamBytes: 519,
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      itemId: "a",
      content: { type: "text", text: "" },
    });
    encoder.encode({ type: "text_delta", index: 0, delta: "abc" });
    encoder.encode({ type: "content_stop", index: 0 });
    encoder.encode({
      type: "content_start",
      index: 1,
      itemId: "b",
      content: { type: "reasoning", text: "", source: "openai-responses" },
    });
    encoder.encode({ type: "reasoning_delta", index: 1, delta: "de" });

    expect(() => encoder.encode({ type: "reasoning_delta", index: 1, delta: "f" })).toThrowError(
      expect.objectContaining({
        code: "STREAM_OUTPUT_TOO_LARGE",
        scope: "stream",
        limitBytes: 519,
      }),
    );
  });

  it("counts a continuation supplied at content_start against the output budget", () => {
    const encoder = new ResponsesStreamEncoder(undefined, {
      perItemBytes: 270,
      perStreamBytes: 1_000,
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });

    expect(() =>
      encoder.encode({
        type: "content_start",
        index: 0,
        itemId: "rs_1",
        content: {
          type: "reasoning",
          text: "",
          source: "openai-responses",
          opaque: {
            provider: "openai-responses",
            kind: "reasoning",
            value: "private-continuation-that-exceeds-budget",
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "STREAM_OUTPUT_TOO_LARGE", scope: "item" }));
  });

  it("appends many citations with linear accumulation cost", () => {
    const encoder = new ResponsesStreamEncoder(undefined, {
      perItemBytes: 4 * 1024 * 1024,
      perStreamBytes: 4 * 1024 * 1024,
    });
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });
    encoder.encode({
      type: "content_start",
      index: 0,
      itemId: "msg_1",
      content: { type: "text", text: "" },
    });

    let lastFrame: ReturnType<ResponsesStreamEncoder["encode"]>[number] | undefined;
    for (let index = 0; index < 20_000; index++) {
      [lastFrame] = encoder.encode({
        type: "citation_delta",
        index: 0,
        citation: { type: "url", url: "x" },
      });
    }

    expect(lastFrame?.data.annotation_index).toBe(19_999);
  }, 1_000);

  it("rejects an output item without its upstream item ID", () => {
    const encoder = new ResponsesStreamEncoder();
    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });

    expect(() =>
      encoder.encode({
        type: "content_start",
        index: 0,
        content: { type: "text", text: "" },
      }),
    ).toThrow(/item ID/);
  });
});
