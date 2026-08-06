import { describe, expect, it } from "vitest";
import { ChatStreamDecoder } from "../../src/protocols/openai-chat/stream-decode.js";

function chunk(decoder: ChatStreamDecoder, payload: Record<string, unknown>) {
  return decoder.decode({ event: "message", data: JSON.stringify(payload) });
}

describe("ChatStreamDecoder", () => {
  it("decodes role, reasoning, text, interleaved tools, usage, and DONE", () => {
    const decoder = new ChatStreamDecoder();
    const base = { id: "chatcmpl_1", model: "model-a" };
    const events = [
      ...chunk(decoder, { ...base, choices: [{ index: 0, delta: { role: "assistant" } }] }),
      ...chunk(decoder, {
        ...base,
        choices: [{ index: 0, delta: { reasoning_content: "plan" } }],
      }),
      ...chunk(decoder, { ...base, choices: [{ index: 0, delta: { content: "answer" } }] }),
      ...chunk(decoder, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_0",
                  type: "function",
                  function: { name: "first", arguments: '{"a":' },
                },
              ],
            },
          },
        ],
      }),
      ...chunk(decoder, {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_1",
                  type: "function",
                  function: { name: "second", arguments: '{"b":2}' },
                },
              ],
            },
          },
        ],
      }),
      ...chunk(decoder, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
      ...chunk(decoder, {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }),
      ...decoder.decode({ event: "message", data: "[DONE]" }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "response_start",
      "content_start",
      "reasoning_delta",
      "content_start",
      "text_delta",
      "content_start",
      "function_arguments_delta",
      "content_start",
      "function_arguments_delta",
      "function_arguments_delta",
      "content_stop",
      "content_stop",
      "content_stop",
      "content_stop",
      "response_complete",
    ]);
    expect(events.filter((event) => event.type === "content_start")).toEqual([
      {
        type: "content_start",
        index: 0,
        content: { type: "reasoning", text: "", source: "openai-chat" },
      },
      { type: "content_start", index: 1, content: { type: "text", text: "" } },
      {
        type: "content_start",
        index: 2,
        content: { type: "function_call", id: "call_0", name: "first", arguments: "" },
      },
      {
        type: "content_start",
        index: 3,
        content: { type: "function_call", id: "call_1", name: "second", arguments: "" },
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "response_complete",
      finishReason: "tool_use",
      usage: { inputTokens: 9, outputTokens: 5, cacheReadInputTokens: 2, reasoningTokens: 1 },
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  it("accepts the reasoning alias and defaults missing usage to zero", () => {
    const decoder = new ChatStreamDecoder();
    const events = [
      ...chunk(decoder, {
        id: "chatcmpl_1",
        model: "model-a",
        choices: [{ index: 0, delta: { reasoning: "plan" }, finish_reason: "stop" }],
      }),
      ...decoder.decode({ event: "message", data: "[DONE]" }),
    ];

    expect(events).toContainEqual({ type: "reasoning_delta", index: 0, delta: "plan" });
    expect(events.at(-1)).toEqual({
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("rejects tool arguments that exceed per-call or stream byte limits", () => {
    const base = { id: "chatcmpl_1", model: "model-a" };
    const perCall = new ChatStreamDecoder({ perCallBytes: 3, perStreamBytes: 10 });
    chunk(perCall, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "limited", arguments: "abc" },
              },
            ],
          },
        },
      ],
    });

    expect(() =>
      chunk(perCall, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "d" } }] },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ scope: "call", code: "TOOL_ARGUMENTS_TOO_LARGE" }));

    const perStream = new ChatStreamDecoder({ perCallBytes: 4, perStreamBytes: 5 });
    chunk(perStream, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "first", arguments: "abc" },
              },
              {
                index: 1,
                id: "call_1",
                type: "function",
                function: { name: "second", arguments: "de" },
              },
            ],
          },
        },
      ],
    });

    expect(() =>
      chunk(perStream, {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, function: { arguments: "f" } }] },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ scope: "stream", code: "TOOL_ARGUMENTS_TOO_LARGE" }));
  });

  it("bounds retained tool identities across the stream", () => {
    const decoder = new ChatStreamDecoder(undefined, {
      perItemBytes: 1024,
      perStreamBytes: 270,
    });
    chunk(decoder, {
      id: "chatcmpl_1",
      model: "model-a",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-a",
                type: "function",
                function: { name: "first", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });

    expect(() =>
      chunk(decoder, {
        id: "chatcmpl_1",
        model: "model-a",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call-b",
                  type: "function",
                  function: { name: "second", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ scope: "stream", code: "STREAM_OUTPUT_TOO_LARGE" }));
  });

  it("rejects incomplete tool argument JSON at the finish reason", () => {
    const decoder = new ChatStreamDecoder();
    chunk(decoder, {
      id: "chatcmpl_1",
      model: "model-a",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "broken", arguments: "{" },
              },
            ],
          },
        },
      ],
    });

    expect(() =>
      chunk(decoder, {
        id: "chatcmpl_1",
        model: "model-a",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    ).toThrow(/complete JSON/);
  });

  it.each([
    "null",
    "[]",
    '"scalar"',
    "42",
    "true",
  ])("rejects non-object tool argument JSON %s at the finish reason", (argumentsJson) => {
    const decoder = new ChatStreamDecoder();
    chunk(decoder, {
      id: "chatcmpl_1",
      model: "model-a",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "invalid", arguments: argumentsJson },
              },
            ],
          },
        },
      ],
    });

    expect(() =>
      chunk(decoder, {
        id: "chatcmpl_1",
        model: "model-a",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    ).toThrow(/JSON object/);
  });

  it("rejects semantic data after finish_reason", () => {
    const decoder = new ChatStreamDecoder();
    const base = { id: "chatcmpl_1", model: "model-a" };
    chunk(decoder, {
      ...base,
      choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
    });

    expect(() =>
      chunk(decoder, {
        ...base,
        choices: [{ index: 0, delta: { content: "must-not-emit" } }],
      }),
    ).toThrow(/after finish_reason/);
    expect(() =>
      chunk(decoder, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ).not.toThrow();
  });

  it("fails when the stream ends without DONE", () => {
    const decoder = new ChatStreamDecoder();
    chunk(decoder, {
      id: "chatcmpl_1",
      model: "model-a",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }],
    });

    expect(() => decoder.finish()).toThrow(/DONE/);
  });
});
