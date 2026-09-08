import { describe, expect, it } from "vitest";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";

describe("Responses 工具结果文本数组", () => {
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
      { type: "input_image", image_url: "https://example.test/image.png" },
    ],
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
