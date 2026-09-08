import { describe, expect, it } from "vitest";
import { type CanonicalEvent, foldCanonicalEvents } from "../../src/core/events.js";
import { decodeChatResponse } from "../../src/protocols/openai-chat/decode.js";
import { encodeChatResponse } from "../../src/protocols/openai-chat/response-encode.js";
import { ChatStreamDecoder } from "../../src/protocols/openai-chat/stream-decode.js";
import { ChatStreamEncoder } from "../../src/protocols/openai-chat/stream-encode.js";

function chunk(
  decoder: ChatStreamDecoder,
  delta: Record<string, unknown>,
  finish: string | null = null,
): CanonicalEvent[] {
  return decoder.decode({
    event: "message",
    data: JSON.stringify({
      id: "chatcmpl_1",
      model: "model-a",
      created: 123,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }),
  });
}

describe("Chat 响应编码", () => {
  it.each([
    ["length", '{"query":'],
    ["tool_calls", "invalid-json"],
  ])("JSON 同协议保留 %s 的工具参数字符串且默认仍严格校验", (finishReason, argumentsJson) => {
    const body = {
      id: "c",
      model: "m",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: argumentsJson },
              },
            ],
          },
        },
      ],
    };
    const response = encodeChatResponse(
      decodeChatResponse(body, { preserveWireMetadata: true, validateToolArguments: false }),
    );
    expect(response.choices[0]).toMatchObject({
      finish_reason: finishReason,
      message: { tool_calls: [{ function: { arguments: argumentsJson } }] },
    });
    expect(() => decodeChatResponse(body)).toThrow(/complete JSON/);
  });

  it.each([
    ["length", '{"query":'],
    ["tool_calls", "invalid-json"],
  ])("SSE 同协议保留 %s 的工具参数字符串且默认仍严格校验", (finishReason, argumentsJson) => {
    const toolDelta = {
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: argumentsJson },
        },
      ],
    };
    const decoder = new ChatStreamDecoder(undefined, undefined, {
      preserveWireMetadata: true,
      validateToolArguments: false,
    });
    const events = [
      ...chunk(decoder, toolDelta),
      ...chunk(decoder, {}, finishReason),
      ...decoder.decode({ event: "message", data: "[DONE]" }),
    ];
    const encoder = new ChatStreamEncoder();
    const frames = events.flatMap((event) => encoder.encode(event));
    expect(frames).toContainEqual({
      data: expect.objectContaining({
        choices: [
          expect.objectContaining({
            delta: {
              tool_calls: [{ index: 0, function: { arguments: argumentsJson } }],
            },
          }),
        ],
      }),
    });
    expect(frames.at(-2)?.data).toMatchObject({ choices: [{ finish_reason: finishReason }] });
    expect(frames.at(-1)?.data).toBe("[DONE]");
    const strict = new ChatStreamDecoder();
    chunk(strict, toolDelta);
    expect(() => chunk(strict, {}, finishReason)).toThrow(/complete JSON/);
  });

  it("不校验工具 JSON 时仍限制工具参数和整体输出字节", () => {
    const toolDelta = {
      tool_calls: [
        { index: 0, id: "c", type: "function", function: { name: "f", arguments: "123456" } },
      ],
    };
    const argumentsLimited = new ChatStreamDecoder(
      { perCallBytes: 5, perStreamBytes: 10 },
      undefined,
      { validateToolArguments: false },
    );
    expect(() => chunk(argumentsLimited, toolDelta)).toThrowError(
      expect.objectContaining({ code: "TOOL_ARGUMENTS_TOO_LARGE" }),
    );
    const outputLimited = new ChatStreamDecoder(
      undefined,
      { perItemBytes: 263, perStreamBytes: 1000 },
      { validateToolArguments: false },
    );
    expect(() => chunk(outputLimited, toolDelta)).toThrowError(
      expect.objectContaining({ code: "STREAM_OUTPUT_TOO_LARGE" }),
    );
  });

  it("拒绝非零候选索引及非助手响应角色", () => {
    const body = { id: "c", model: "m", usage: { prompt_tokens: 1, completion_tokens: 1 } };
    expect(() =>
      decodeChatResponse({
        ...body,
        choices: [{ index: 1, message: { content: "x" }, finish_reason: "stop" }],
      }),
    ).toThrow(/索引/);
    expect(() =>
      decodeChatResponse({
        ...body,
        choices: [{ index: 0, message: { role: "user", content: "x" }, finish_reason: "stop" }],
      }),
    ).toThrow(/角色/);
  });
  it.each([
    "stop",
    "content_filter",
  ])("JSON 保留拒绝内容、上游结束原因 %s 和创建时间", (finishReason) => {
    const response = decodeChatResponse(
      {
        id: "chatcmpl_1",
        model: "model-a",
        created: 123,
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              refusal: "不能协助",
              reasoning_content: "考虑约束",
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
      { preserveWireMetadata: true },
    );
    expect(encodeChatResponse(response)).toEqual({
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "model-a",
      created: 123,
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: null,
            refusal: "不能协助",
            reasoning_content: "考虑约束",
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    });
  });

  it("JSON 编码工具调用并且不填充上游缺失的缓存统计", () => {
    const response = encodeChatResponse({
      id: "c",
      model: "m",
      finishReason: "tool_use",
      usage: { inputTokens: 2, outputTokens: 3 },
      content: [
        { type: "text", text: "结果" },
        { type: "function_call", id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      ],
    });
    expect(response.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: "结果",
        refusal: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
    });
    expect(response.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  });

  it("SSE 将拒绝与文本分离，折叠时仍保留拒绝语义", () => {
    const decoder = new ChatStreamDecoder(undefined, undefined, { preserveWireMetadata: true });
    const events = [
      ...chunk(decoder, { role: "assistant", reasoning_content: "思考" }),
      ...chunk(decoder, { content: "说明", refusal: "不能" }),
      ...chunk(decoder, { refusal: "协助" }, "stop"),
      ...decoder.decode({ event: "message", data: "[DONE]" }),
    ];
    const folded = foldCanonicalEvents(events);
    expect(folded.finishReason).toBe("refusal");
    expect(folded.content).toEqual([
      { type: "reasoning", text: "思考", source: "openai-chat" },
      { type: "text", text: "说明" },
      { type: "refusal", refusal: "不能协助" },
    ]);
    expect(encodeChatResponse(folded).choices[0]?.finish_reason).toBe("stop");
    const encoder = new ChatStreamEncoder();
    const frames = events.flatMap((event) => encoder.encode(event));
    const payloads = frames.map((frame) => frame.data).filter((data) => typeof data !== "string");
    expect(
      payloads.every(
        (data) => data.id === "chatcmpl_1" && data.model === "model-a" && data.created === 123,
      ),
    ).toBe(true);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        choices: [expect.objectContaining({ delta: { refusal: "不能" } })],
      }),
    );
    expect(payloads).toContainEqual(
      expect.objectContaining({
        choices: [expect.objectContaining({ delta: { reasoning_content: "思考" } })],
      }),
    );
    expect(payloads.every((data) => !("usage" in data))).toBe(true);
    expect(frames.at(-2)?.data).toMatchObject({ choices: [{ finish_reason: "stop", delta: {} }] });
    expect(frames.at(-1)?.data).toBe("[DONE]");
  });

  it("工具索引连续且参数实时增量输出，仅按请求提供最终 usage", () => {
    const encoder = new ChatStreamEncoder({ includeUsage: true });
    encoder.encode({ type: "response_start", id: "c", model: "m" });
    const first = encoder.encode({
      type: "content_start",
      index: 8,
      content: { type: "function_call", id: "call_a", name: "a", arguments: "" },
    });
    const second = encoder.encode({
      type: "content_start",
      index: 2,
      content: { type: "function_call", id: "call_b", name: "b", arguments: "" },
    });
    expect(first[0]?.data).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a" }] } }],
      usage: null,
    });
    expect(second[0]?.data).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b" }] } }],
    });
    expect(
      encoder.encode({ type: "function_arguments_delta", index: 8, delta: '{"x":' })[0]?.data,
    ).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }],
    });
    encoder.encode({ type: "function_arguments_delta", index: 8, delta: "1}" });
    encoder.encode({ type: "function_arguments_delta", index: 2, delta: "{}" });
    encoder.encode({ type: "content_stop", index: 8 });
    encoder.encode({ type: "content_stop", index: 2 });
    expect(
      encoder.encode({
        type: "response_complete",
        finishReason: "tool_use",
        usage: { inputTokens: 2, outputTokens: 3 },
      }),
    ).toEqual([
      {
        data: expect.objectContaining({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null }],
          usage: null,
        }),
      },
      {
        data: expect.objectContaining({
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]);
  });

  it("错误帧清洗上游消息且不发送正常结束标志", () => {
    const encoder = new ChatStreamEncoder();
    encoder.encode({ type: "response_start", id: "c", model: "m" });
    const frames = encoder.encode({
      type: "response_error",
      error: {
        status: 500,
        code: "sk-secret",
        message: "sk-secret",
        retryable: false,
      },
    });
    expect(frames).toHaveLength(1);
    expect(JSON.stringify(frames)).not.toContain("sk-secret");
    expect(JSON.stringify(frames)).not.toContain("[DONE]");
    expect(() =>
      encoder.encode({
        type: "response_complete",
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    ).toThrow();
  });

  it.each(["content", "reasoning_content", "refusal"])("限制 %s 输出字节", (field) => {
    const decoder = new ChatStreamDecoder(undefined, { perItemBytes: 5, perStreamBytes: 20 });
    chunk(decoder, { [field]: "12345" });
    expect(() => chunk(decoder, { [field]: "6" })).toThrowError(
      expect.objectContaining({ code: "STREAM_OUTPUT_TOO_LARGE", scope: "item" }),
    );
  });

  it("拒绝流创建时间漂移与未关闭内容", () => {
    const decoder = new ChatStreamDecoder();
    chunk(decoder, { content: "a" });
    expect(() =>
      decoder.decode({
        event: "message",
        data: JSON.stringify({ id: "chatcmpl_1", model: "model-a", created: 124, choices: [] }),
      }),
    ).toThrow(/created/);
    const encoder = new ChatStreamEncoder();
    encoder.encode({ type: "response_start", id: "c", model: "m" });
    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });
    expect(() =>
      encoder.encode({
        type: "response_complete",
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    ).toThrow(/未结束/);
  });
});
