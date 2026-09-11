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

  it("folds a refusal part into the open text block and reports a refusal finish", () => {
    const decoder = new ResponsesStreamDecoder();
    const events = [
      ...decode(decoder, "response.created", {
        response: { id: "resp_1", model: "model-a" },
      }),
      ...decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
      ...decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot help with that" }],
        },
      }),
      ...decode(decoder, "response.completed", {
        response: {
          status: "completed",
          usage: { input_tokens: 3, output_tokens: 5 },
        },
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "text_delta",
      "content_stop",
      "response_complete",
    ]);
    expect(events[2]).toEqual({
      type: "text_delta",
      index: 0,
      delta: "I cannot help with that",
    });
    expect(events.at(-1)).toMatchObject({
      type: "response_complete",
      finishReason: "refusal",
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  it("keeps output_text alongside a trailing refusal part in output_item.done", () => {
    const decoder = new ResponsesStreamDecoder();
    const events = [
      ...decode(decoder, "response.created", {
        response: { id: "resp_1", model: "model-a" },
      }),
      ...decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
      ...decode(decoder, "response.output_text.delta", { output_index: 0, delta: "partial" }),
      ...decode(decoder, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "partial", annotations: [] },
            { type: "refusal", refusal: "rest refused" },
          ],
        },
      }),
      ...decode(decoder, "response.completed", {
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 2 } },
      }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "text_delta",
      "text_delta",
      "content_stop",
      "response_complete",
    ]);
    expect(events[3]).toEqual({ type: "text_delta", index: 0, delta: "rest refused" });
    expect(events.at(-1)).toMatchObject({ finishReason: "refusal" });
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
  it("decodes response.incomplete into an incomplete completion", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "model-a" } });
    expect(
      decoder.decode({
        event: "response.incomplete",
        data: JSON.stringify({
          type: "response.incomplete",
          response: {
            id: "resp_1",
            model: "model-a",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        }),
      }),
    ).toEqual([
      {
        type: "response_complete",
        finishReason: "max_tokens",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
  });

  it("rejects lifecycle violations and malformed payload JSON", () => {
    expect(() =>
      new ResponsesStreamDecoder().decode({ event: "response.created", data: "[DONE]" }),
    ).toThrow(/before its terminal event/);

    expect(() => new ResponsesStreamDecoder().decode({ event: "message", data: "{bad" })).toThrow(
      /invalid JSON/,
    );
    expect(() => new ResponsesStreamDecoder().decode({ event: "message", data: "null" })).toThrow(
      /must contain a JSON object/,
    );

    const dup = new ResponsesStreamDecoder();
    decode(dup, "response.created", { response: { id: "resp_1", model: "m" } });
    expect(() =>
      decode(dup, "response.created", { response: { id: "resp_1", model: "m" } }),
    ).toThrow(/more than once/);

    const beforeStart = new ResponsesStreamDecoder();
    expect(() =>
      decode(beforeStart, "response.output_item.added", { output_index: 0, item: {} }),
    ).toThrow(/has not emitted response.created/);

    const mismatch = new ResponsesStreamDecoder();
    expect(() =>
      mismatch.decode({
        event: "response.output_text.delta",
        data: JSON.stringify({ type: "response.created" }),
      }),
    ).toThrow(/does not match its SSE event name/);

    const created = () => {
      const decoder = new ResponsesStreamDecoder();
      decode(decoder, "response.created", { response: { id: "resp_1", model: "m" } });
      return decoder;
    };

    const afterTerminal = created();
    decode(afterTerminal, "response.completed", {
      response: { id: "resp_1", model: "m", output: [], usage: {} },
    });
    expect(() =>
      decode(afterTerminal, "response.output_text.delta", { output_index: 0, delta: "x" }),
    ).toThrow(/after its terminal event/);

    const openOnComplete = created();
    decode(openOnComplete, "response.output_item.added", {
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    });
    expect(() =>
      decode(openOnComplete, "response.completed", {
        response: { id: "resp_1", model: "m", output: [], usage: {} },
      }),
    ).toThrow(/open output items/);
  });
  it("handles added items with pre-filled body and annotations, and rejects unknown item types", () => {
    const computed = new ResponsesStreamDecoder();
    decode(computed, "response.created", { response: { id: "resp_1", model: "m" } });
    const events = decode(computed, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "prefilled",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.test/s",
                title: "T",
                start_index: 0,
                end_index: 9,
              },
            ],
          },
        ],
      },
    });
    expect(events).toEqual([
      { type: "content_start", index: 0, itemId: "msg_1", content: { type: "text", text: "" } },
      { type: "text_delta", index: 0, delta: "prefilled" },
      {
        type: "citation_delta",
        index: 0,
        citation: {
          type: "url",
          url: "https://example.test/s",
          title: "T",
          startIndex: 0,
          endIndex: 9,
        },
      },
    ]);

    const withArgs = new ResponsesStreamDecoder();
    decode(withArgs, "response.created", { response: { id: "resp_1", model: "m" } });
    const argEvents = decode(withArgs, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "{}",
      },
    });
    expect(argEvents).toEqual([
      {
        type: "content_start",
        index: 0,
        itemId: "fc_1",
        content: { type: "function_call", id: "call_1", name: "weather", arguments: "" },
      },
      { type: "function_arguments_delta", index: 0, delta: "{}" },
    ]);

    const unknownItem = new ResponsesStreamDecoder();
    decode(unknownItem, "response.created", { response: { id: "resp_1", model: "m" } });
    expect(() =>
      decode(unknownItem, "response.output_item.added", {
        output_index: 0,
        item: { id: "x", type: "custom_tool" },
      }),
    ).toThrow(/Unsupported Responses output item/);

    const wrongRole = new ResponsesStreamDecoder();
    decode(wrongRole, "response.created", { response: { id: "resp_1", model: "m" } });
    expect(() =>
      decode(wrongRole, "response.output_item.added", {
        output_index: 0,
        item: { id: "m1", type: "message", role: "user", content: [] },
      }),
    ).toThrow(/role must be assistant/);
  });
  it("rejects malformed annotation and done events", () => {
    const base = () => {
      const decoder = new ResponsesStreamDecoder();
      decode(decoder, "response.created", { response: { id: "resp_1", model: "m" } });
      decode(decoder, "response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      });
      return decoder;
    };

    const badAnnotationType = base();
    expect(() =>
      decode(badAnnotationType, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "msg_1",
        content_index: 0,
        annotation_index: 0,
        annotation: { type: "file_citation", file_id: "f" },
      }),
    ).toThrow(/Unsupported Responses output text annotation/);

    const badItemId = base();
    expect(() =>
      decode(badItemId, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "other",
        content_index: 0,
        annotation_index: 0,
        annotation: { type: "url_citation", url: "https://x.test/s" },
      }),
    ).toThrow(/changed its item ID/);

    const badContentIndex = base();
    expect(() =>
      decode(badContentIndex, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "msg_1",
        content_index: 1,
        annotation_index: 0,
        annotation: { type: "url_citation", url: "https://x.test/s" },
      }),
    ).toThrow(/内容块索引必须从零开始按顺序添加/);

    const outOfOrder = base();
    decode(outOfOrder, "response.output_text.annotation.added", {
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      annotation_index: 0,
      annotation: { type: "url_citation", url: "https://x.test/s" },
    });
    expect(() =>
      decode(outOfOrder, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "msg_1",
        content_index: 0,
        annotation_index: 2,
        annotation: { type: "url_citation", url: "https://x.test/s" },
      }),
    ).toThrow(/emitted in order/);

    const argsOnMessage = base();
    expect(() =>
      decode(argsOnMessage, "response.function_call_arguments.delta", {
        output_index: 0,
        delta: "{}",
      }),
    ).toThrow(/is not open as function_call/);

    const doneUnopened = new ResponsesStreamDecoder();
    decode(doneUnopened, "response.created", { response: { id: "resp_1", model: "m" } });
    expect(() =>
      decode(doneUnopened, "response.output_item.done", { output_index: 9, item: {} }),
    ).toThrow(/is not open$/);
  });
  it("validates done items against open items", () => {
    const created = () => {
      const decoder = new ResponsesStreamDecoder();
      decode(decoder, "response.created", { response: { id: "resp_1", model: "m" } });
      return decoder;
    };

    const roleMismatch = created();
    decode(roleMismatch, "response.output_item.added", {
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    });
    expect(() =>
      decode(roleMismatch, "response.output_item.done", {
        output_index: 0,
        item: { id: "m1", type: "message", role: "user", content: [] },
      }),
    ).toThrow(/done role does not match/);

    const badEncrypted = created();
    decode(badEncrypted, "response.output_item.added", {
      output_index: 0,
      item: { id: "r1", type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
    });
    expect(() =>
      decode(badEncrypted, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "r1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "plan" }],
          encrypted_content: "",
        },
      }),
    ).toThrow(/invalid encrypted content/);

    const badSummary = created();
    decode(badSummary, "response.output_item.added", {
      output_index: 0,
      item: { id: "r1", type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
    });
    expect(() =>
      decode(badSummary, "response.output_item.done", {
        output_index: 0,
        item: { id: "r1", type: "reasoning", summary: "not-array" },
      }),
    ).toThrow(/summary does not match/);

    const fnMismatch = created();
    decode(fnMismatch, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "",
      },
    });
    expect(() =>
      decode(fnMismatch, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "other",
          name: "weather",
          arguments: "{}",
        },
      }),
    ).toThrow(/done function does not match/);

    const badDoneArgs = created();
    decode(badDoneArgs, "response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call_1",
        name: "weather",
        arguments: "",
      },
    });
    expect(() =>
      decode(badDoneArgs, "response.output_item.done", {
        output_index: 0,
        item: {
          id: "fc_1",
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: "{",
        },
      }),
    ).toThrow(/must contain complete JSON/);
  });

  it("defaults missing usage to zeros", () => {
    const decoder = new ResponsesStreamDecoder();
    decode(decoder, "response.created", { response: { id: "resp_1", model: "m" } });
    expect(
      decode(decoder, "response.completed", {
        response: { id: "resp_1", model: "m", output: [] },
      }),
    ).toEqual([
      {
        type: "response_complete",
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
  });
  it("rejects malformed structural fields across events", () => {
    expect(() =>
      new ResponsesStreamDecoder().decode({
        event: "response.created",
        data: JSON.stringify({ type: "response.created", response: "x" }),
      }),
    ).toThrow(/field response must be an object/);

    expect(() =>
      new ResponsesStreamDecoder().decode({
        event: "response.created",
        data: JSON.stringify({ type: "response.created", response: { id: 5, model: "m" } }),
      }),
    ).toThrow(/field id must be a string/);

    const missingIndex = new ResponsesStreamDecoder();
    decode(missingIndex, "response.created", { response: { id: "r", model: "m" } });
    expect(() =>
      decode(missingIndex, "response.output_item.added", {
        item: { id: "m1", type: "message", role: "assistant", content: [] },
      }),
    ).toThrow(/field output_index must be an integer/);

    // annotation on a non-message item
    const fnItem = new ResponsesStreamDecoder();
    decode(fnItem, "response.created", { response: { id: "r", model: "m" } });
    decode(fnItem, "response.output_item.added", {
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "c", name: "f", arguments: "" },
    });
    expect(() =>
      decode(fnItem, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "fc_1",
        content_index: 0,
        annotation_index: 0,
        annotation: { type: "url_citation", url: "https://x.test/s" },
      }),
    ).toThrow(/is not open as message/);

    // annotation value not an object
    const badAnnotation = new ResponsesStreamDecoder();
    decode(badAnnotation, "response.created", { response: { id: "r", model: "m" } });
    decode(badAnnotation, "response.output_item.added", {
      output_index: 0,
      item: { id: "m1", type: "message", role: "assistant", content: [] },
    });
    expect(() =>
      decode(badAnnotation, "response.output_text.annotation.added", {
        output_index: 0,
        item_id: "m1",
        content_index: 0,
        annotation_index: 0,
        annotation: "not-an-object",
      }),
    ).toThrow(/annotation must be an object/);
  });

  it("rejects malformed item bodies and done bodies", () => {
    const created = () => {
      const decoder = new ResponsesStreamDecoder();
      decode(decoder, "response.created", { response: { id: "r", model: "m" } });
      return decoder;
    };

    const badContent = created();
    expect(() =>
      decode(badContent, "response.output_item.added", {
        output_index: 0,
        item: { id: "m1", type: "message", role: "assistant", content: "not-array" },
      }),
    ).toThrow(/content does not match/);

    const badPart = created();
    expect(() =>
      decode(badPart, "response.output_item.added", {
        output_index: 0,
        item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_image" }] },
      }),
    ).toThrow(/content does not match/);

    const badAnnotations = created();
    expect(() =>
      decode(badAnnotations, "response.output_item.added", {
        output_index: 0,
        item: {
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x", annotations: "x" }],
        },
      }),
    ).toThrow(/annotations do not match/);

    const badSummaryPart = created();
    expect(() =>
      decode(badSummaryPart, "response.output_item.added", {
        output_index: 0,
        item: { id: "r1", type: "reasoning", summary: [{ type: "output_text", text: "x" }] },
      }),
    ).toThrow(/summary does not match/);
  });
});
