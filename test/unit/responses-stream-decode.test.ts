import { describe, expect, it } from "vitest";
import { foldCanonicalEvents } from "../../src/core/events.js";
import { ResponsesStreamDecoder } from "../../src/protocols/openai-responses/stream-decode.js";

function decode(decoder: ResponsesStreamDecoder, type: string, payload: Record<string, unknown>) {
  return decoder.decode({ event: type, data: JSON.stringify({ type, ...payload }) });
}

describe("ResponsesStreamDecoder", () => {
  it("decodes text, function arguments, and terminal usage in output order", () => {
    const decoder = new ResponsesStreamDecoder();
    const events = [
      ...decode(decoder, "response.created", {
        response: { id: "resp_1", model: "model-a" },
      }),
      ...decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
      ...decode(decoder, "response.output_text.delta", { output_index: 0, delta: "hello" }),
      ...decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello", annotations: [] }],
        },
      }),
      ...decode(decoder, "response.output_item.added", {
        output_index: 1,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Read", arguments: "" },
      }),
      ...decode(decoder, "response.function_call_arguments.delta", {
        output_index: 1,
        delta: '{"file_path":',
      }),
      ...decode(decoder, "response.function_call_arguments.delta", {
        output_index: 1,
        delta: '"/tmp/a"}',
      }),
      ...decode(decoder, "response.output_item.done", {
        output_index: 1,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "Read",
          arguments: '{"file_path":"/tmp/a"}',
        },
      }),
      ...decode(decoder, "response.completed", {
        response: {
          status: "completed",
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: 2 },
          },
        },
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "text_delta",
      "content_stop",
      "content_start",
      "function_arguments_delta",
      "function_arguments_delta",
      "content_stop",
      "response_complete",
    ]);
    expect(events.at(-1)).toEqual({
      type: "response_complete",
      finishReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2 },
    });
  });

  it("decodes URL annotation events and accepts DONE after the terminal event", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", {
      response: { id: "resp_1", model: "model-a" },
    });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    });

    decode(decoder, "response.output_text.delta", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hello",
    });
    expect(
      decode(decoder, "response.output_text.annotation.added", {
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
      }),
    ).toEqual([
      {
        type: "citation_delta",
        index: 0,
        citation: {
          type: "url",
          url: "https://example.test/source",
          title: "Source",
          startIndex: 0,
          endIndex: 5,
        },
      },
    ]);

    decode(decoder, "response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
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
    });
    decode(decoder, "response.completed", {
      response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(decoder.decode({ event: "message", data: "[DONE]" })).toEqual([]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("preserves reasoning encrypted content from the completed output item", () => {
    const decoder = new ResponsesStreamDecoder();
    const events = [
      ...decode(decoder, "response.created", {
        response: { id: "resp_1", model: "model-a" },
      }),
      ...decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "rs_1", type: "reasoning", summary: [] },
      }),
      ...decode(decoder, "response.reasoning_summary_text.delta", {
        output_index: 0,
        delta: "plan",
      }),
      ...decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "plan" }],
          encrypted_content: "encrypted-real",
        },
      }),
      ...decode(decoder, "response.completed", {
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      }),
    ];

    expect(events).toContainEqual({
      type: "reasoning_continuation",
      index: 0,
      opaque: {
        provider: "openai-responses",
        kind: "reasoning",
        value: "encrypted-real",
      },
    });
    expect(foldCanonicalEvents(events).content).toEqual([
      {
        type: "reasoning",
        id: "rs_1",
        text: "plan",
        source: "openai-responses",
        opaque: {
          provider: "openai-responses",
          kind: "reasoning",
          value: "encrypted-real",
        },
      },
    ]);
  });

  it("emits content already present in output_item.added and always reconciles done", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });

    expect(
      decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "initial", annotations: [] }],
        },
      }),
    ).toEqual([
      { type: "content_start", index: 0, itemId: "msg_1", content: { type: "text", text: "" } },
      { type: "text_delta", index: 0, delta: "initial" },
    ]);

    expect(() =>
      decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "changed", annotations: [] }],
        },
      }),
    ).toThrow(/done body does not match/);
  });

  it("rejects annotation reordering or mutation in output_item.done", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    });
    decode(decoder, "response.output_text.annotation.added", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      annotation_index: 0,
      annotation: {
        type: "url_citation",
        url: "https://example.test/source",
        title: "Public",
        start_index: 0,
        end_index: 1,
      },
    });

    expect(() =>
      decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/private",
                  title: "Public",
                  start_index: 0,
                  end_index: 1,
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(/annotations do not match/);
  });

  it("rejects reuse of a closed output index", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    });
    decode(decoder, "response.output_item.done", {
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] },
    });

    expect(() =>
      decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_2", type: "message", role: "assistant", content: [] },
      }),
    ).toThrow(/already defined/);
  });

  it("maps upstream-controlled error codes to a fixed public code", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });

    expect(
      decode(decoder, "error", {
        error: { status: 502, code: "private-tenant-secret", message: "private body" },
      }),
    ).toEqual([
      {
        type: "response_error",
        error: {
          status: 502,
          code: "responses_stream_error",
          message: "The upstream Responses stream failed",
          retryable: false,
        },
      },
    ]);
  });

  it.each([
    {
      label: "changed item ID",
      added: { id: "msg_1", type: "message", role: "assistant", content: [] },
      deltas: [
        { type: "response.output_text.delta", payload: { output_index: 0, delta: "hello" } },
      ],
      done: {
        id: "msg_changed",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      },
    },
    {
      label: "changed text",
      added: { id: "msg_1", type: "message", role: "assistant", content: [] },
      deltas: [
        { type: "response.output_text.delta", payload: { output_index: 0, delta: "hello" } },
      ],
      done: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "different", annotations: [] }],
      },
    },
    {
      label: "changed function arguments",
      added: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "",
      },
      deltas: [
        {
          type: "response.function_call_arguments.delta",
          payload: { output_index: 0, delta: '{"city":"Paris"}' },
        },
      ],
      done: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: '{"city":"London"}',
      },
    },
  ])("rejects output_item.done with $label", ({ added, deltas, done }) => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", { output_index: 0, item: added });
    for (const delta of deltas) {
      decode(decoder, delta.type, delta.payload);
    }

    expect(() =>
      decode(decoder, "response.output_item.done", { output_index: 0, item: done }),
    ).toThrow(/does not match/);
  });

  it("bounds retained output item identities across the stream", () => {
    const decoder = new ResponsesStreamDecoder(undefined, {
      perItemBytes: 1024,
      perStreamBytes: 520,
    });
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: { id: "item-a", type: "message", role: "assistant", content: [] },
    });
    decode(decoder, "response.output_item.done", {
      output_index: 0,
      item: { id: "item-a", type: "message", role: "assistant", content: [] },
    });

    expect(() =>
      decode(decoder, "response.output_item.added", {
        output_index: 1,
        item: { id: "item-b", type: "message", role: "assistant", content: [] },
      }),
    ).toThrowError(expect.objectContaining({ scope: "stream", code: "STREAM_OUTPUT_TOO_LARGE" }));
  });

  it.each([
    "null",
    "[]",
    '"scalar"',
    "42",
    "true",
  ])("rejects non-object function arguments %s in output_item.done", (argumentsJson) => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "invalid",
        arguments: "",
      },
    });
    decode(decoder, "response.function_call_arguments.delta", {
      output_index: 0,
      delta: argumentsJson,
    });

    expect(() =>
      decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "invalid",
          arguments: argumentsJson,
        },
      }),
    ).toThrow(/JSON object/);
  });

  it("rejects function arguments that exceed configured byte limits", () => {
    const decoder = new ResponsesStreamDecoder({ perCallBytes: 3, perStreamBytes: 3 });
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    decode(decoder, "response.output_item.added", {
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "limited" },
    });
    decode(decoder, "response.function_call_arguments.delta", {
      output_index: 0,
      delta: "abc",
    });

    expect(() =>
      decode(decoder, "response.function_call_arguments.delta", {
        output_index: 0,
        delta: "private-fragment",
      }),
    ).toThrowError(expect.objectContaining({ scope: "call", code: "TOOL_ARGUMENTS_TOO_LARGE" }));
  });

  it("fails on an unknown user-visible event", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });

    expect(() => decode(decoder, "response.audio.delta", { delta: "..." })).toThrow(/Unsupported/);
  });

  it("fails when the stream ends without a terminal event", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });

    expect(() => decoder.finish()).toThrow(/terminal/);
  });
});
