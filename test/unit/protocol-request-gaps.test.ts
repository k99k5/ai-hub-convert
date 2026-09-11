import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";

const options = {
  store: false,
  promptCache: { kind: "none" as const },
  replaySourceExtensions: true,
};
const base = { model: "model-test", input: "返回 JSON" };
const roundtrip = (input: unknown) =>
  encodeResponsesRequest(decodeResponsesRequest(input), options);

describe("请求协议遗漏回归", () => {
  it.each([
    {},
    { format: { type: "text" } },
    { format: { type: "json_object" } },
    ...[undefined, null, false, true].map((strict) => ({
      format: {
        type: "json_schema",
        name: "answer_schema",
        description: "输出结构",
        schema: { type: "object", properties: { answer: { type: "string" } } },
        ...(strict === undefined ? {} : { strict }),
      },
      verbosity: "low",
    })),
    { verbosity: null },
  ])("同协议保留文本配置 %#", (text) => {
    expect(roundtrip({ ...base, text }).text).toEqual(text);
  });

  it.each([
    null,
    { unsupported: true },
    { format: null },
    { format: { type: "text", schema: {} } },
    { format: { type: "xml" } },
    { format: { type: "json_schema", name: "a", schema: [], strict: true } },
    { format: { type: "json_schema", name: "a", schema: {}, strict: "yes" } },
    { format: { type: "json_schema", name: "", schema: {} } },
    { verbosity: "extreme" },
  ])("拒绝非法文本配置 %#", (text) => {
    expect(() => roundtrip({ ...base, text })).toThrow();
  });

  it.each(["low", "high", "original", "auto"])("保留图片精度 %s", (detail) => {
    const body = roundtrip({
      ...base,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "比较图片" },
            { type: "input_image", image_url: "https://example.test/a.png", detail },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "low" },
          ],
        },
      ],
    });
    expect(body.input[0]).toMatchObject({
      content: [
        { type: "input_text", text: "比较图片" },
        { type: "input_image", detail },
        { type: "input_image", detail: "low" },
      ],
    });
  });

  it.each([null, "invalid", 1])("拒绝非法图片精度 %#", (detail) => {
    expect(() =>
      roundtrip({
        ...base,
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.test/a.png", detail }],
          },
        ],
      }),
    ).toThrow();
  });

  it.each([undefined, null, false, true])("保留工具 strict 的缺省与显式值 %#", (strict) => {
    const tool = {
      type: "function",
      name: "f",
      parameters: { type: "object" },
      ...(strict === undefined ? {} : { strict }),
    };
    expect(roundtrip({ ...base, tools: [tool] }).tools).toEqual([tool]);
  });

  it("过滤允许工具后仍保留对应 strict", () => {
    const tools = [
      { type: "function", name: "a", parameters: {}, strict: true },
      { type: "function", name: "b", parameters: {}, strict: null },
      { type: "function", name: "c", parameters: {} },
    ];
    expect(
      roundtrip({
        ...base,
        tools,
        tool_choice: {
          type: "allowed_tools",
          mode: "auto",
          tools: [
            { type: "function", name: "b" },
            { type: "function", name: "c" },
          ],
        },
      }).tools,
    ).toEqual(tools.slice(1));
  });

  it("转换 Anthropic 历史时保留文本和工具调用顺序", () => {
    const request = decodeAnthropicRequest({
      model: "m",
      max_tokens: 64,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "调用前" },
            { type: "tool_use", id: "c", name: "f", input: {} },
            { type: "text", text: "调用后" },
          ],
        },
      ],
    });
    expect(encodeResponsesRequest(request, options).input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "调用前" }] },
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "调用后" }] },
    ]);
  });

  it.each([false, true])("跨协议保留工具失败信息 is_error=%s", (is_error) => {
    const request = decodeAnthropicRequest({
      model: "m",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c", content: "0\n", is_error }],
        },
      ],
    });
    const output = is_error ? JSON.stringify({ is_error: true, output: "0\n" }) : "0\n";
    expect(encodeResponsesRequest(request, options).input[0]).toMatchObject({ output });
    expect(encodeChatRequest(request).messages[0]).toMatchObject({ content: output });
  });

  it("Anthropic 搜索位置进入现有中间表示，忽略空值", () => {
    const request = decodeAnthropicRequest({
      model: "m",
      max_tokens: 64,
      messages: [],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          user_location: { type: "approximate", city: "上海", country: "CN", region: null },
        },
      ],
    });
    expect(request.tools[0]).toMatchObject({ userLocation: { city: "上海", country: "CN" } });
    expect(encodeResponsesRequest(request, options).tools?.[0]?.description).toContain("上海");
    expect(encodeChatRequest(request).tools?.[0]?.function.description).toContain("上海");
  });
});
