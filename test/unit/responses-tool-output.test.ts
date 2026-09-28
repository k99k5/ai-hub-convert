import { describe, expect, it } from "vitest";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesChatRequest } from "../../src/protocols/openai-responses/chat-bridge.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";

describe("Responses 工具结果内容数组", () => {
  it.each([false, true])("Anthropic 带图工具结果保留失败标记：%s", (is_error) => {
    const request = decodeAnthropicRequest({
      model: "model-test",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "browser",
              is_error,
              content: [
                { type: "text", text: "page failed" },
                { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
              ],
            },
          ],
        },
      ],
    });
    expect(
      encodeResponsesRequest(request, { store: false, promptCache: { kind: "none" } }).input,
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "browser",
        output: [
          ...(is_error ? [{ type: "input_text", text: '{"is_error":true}' }] : []),
          { type: "input_text", text: "page failed" },
          { type: "input_image", image_url: "https://example.test/image.png", detail: "auto" },
        ],
      },
    ]);
    const messages = encodeChatRequest(request).messages;
    expect(messages[0]).toEqual({
      role: "tool",
      tool_call_id: "browser",
      content: is_error ? '{"is_error":true,"output":"page failed"}' : "page failed",
    });
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Tool result (browser):" },
        { type: "text", text: "page failed" },
        { type: "image_url", image_url: { url: "https://example.test/image.png" } },
      ],
    });
  });

  it.each([
    { output: "原有结果", expected: "原有结果" },
    { output: "", expected: "" },
    { output: [], expected: "" },
    { output: [{ type: "input_text", text: "" }], expected: "" },
    {
      output: [
        { type: "input_text", text: "第一条\n" },
        { type: "input_text", text: "" },
        { type: "input_text", text: " 第二条 " },
      ],
      expected: "第一条\n 第二条 ",
    },
  ])("字符串与文本数组保留原有文本及顺序：%j", ({ output, expected }) => {
    const canonical = decodeResponsesRequest({
      model: "model-test",
      input: [{ type: "function_call_output", call_id: "search_1", output }],
    });
    expect(canonical.messages).toEqual([
      {
        role: "tool",
        content: [
          { type: "function_result", callId: "search_1", output: expected, isError: false },
        ],
      },
    ]);
    expect(
      encodeResponsesRequest(canonical, { store: false, promptCache: { kind: "none" } }),
    ).toHaveProperty("input", [
      { type: "function_call_output", call_id: "search_1", output: expected },
    ]);
  });

  it.each([
    "https://example.test/image.png",
    "data:image/png;base64,aGVsbG8=",
  ])("保留工具截图、文本顺序和 detail：%s", (image_url) => {
    const output = [
      { type: "input_text", text: "before" },
      { type: "input_image", image_url, detail: "original" },
      { type: "input_text", text: "after" },
    ];
    const request = decodeResponsesRequest({
      model: "model-test",
      input: [{ type: "function_call_output", call_id: "screenshot", output }],
    });
    expect(
      encodeResponsesRequest(request, { store: false, promptCache: { kind: "none" } }).input,
    ).toEqual([{ type: "function_call_output", call_id: "screenshot", output }]);
    expect(encodeResponsesChatRequest(request).messages).toEqual([
      { role: "tool", tool_call_id: "screenshot", content: "beforeafter" },
      {
        role: "user",
        content: [
          { type: "text", text: "Tool result (screenshot):" },
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: image_url, detail: "high" } },
          { type: "text", text: "after" },
        ],
      },
    ]);
  });

  it("支持只有图片的工具结果", () => {
    const request = decodeResponsesRequest({
      model: "model-test",
      input: [
        {
          type: "function_call_output",
          call_id: "screenshot",
          output: [{ type: "input_image", image_url: "https://example.test/image.png" }],
        },
      ],
    });
    expect(encodeResponsesChatRequest(request).messages).toHaveLength(2);
    expect(
      encodeResponsesRequest(request, { store: false, promptCache: { kind: "none" } }).input,
    ).toMatchObject([{ output: [{ type: "input_image", detail: "auto" }] }]);
  });

  it.each([
    null,
    5,
    {},
    [null],
    ["文本"],
    [{ type: "input_text" }],
    [{ type: "input_text", text: 5 }],
    [{ type: "output_text", text: "文本" }],
    [
      { type: "input_text", text: "不能只保留这段文字" },
      { type: "input_image", image_url: "https://example.test/image.png", detail: "invalid" },
    ],
    [{ type: "input_image" }],
    [{ type: "input_image", image_url: "data:image/svg+xml;base64,c3Zn" }],
    [{ type: "input_image", file_id: "file-test" }],
    [{ type: "input_file", file_id: "file-test" }],
  ])("拒绝非法或无法表达的工具结果，避免静默丢失内容：%j", (output) => {
    expect(() =>
      decodeResponsesRequest({
        model: "model-test",
        input: [{ type: "function_call_output", call_id: "search_1", output }],
      }),
    ).toThrow();
  });
});
