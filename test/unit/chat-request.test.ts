import { describe, expect, it } from "vitest";
import { decodeChatRequest } from "../../src/protocols/openai-chat/request-decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";

const base = { model: "gpt-test", messages: [{ role: "user", content: "你好" }] };

describe("Chat 请求适配", () => {
  it("将普通消息解码为既有规范请求", () => {
    expect(decodeChatRequest(base)).toEqual({
      source: "openai-chat",
      model: "gpt-test",
      messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
      tools: [],
      stream: false,
    });
  });

  it("保留开发者角色、图片精度、工具调用和结果、推理及拒绝", () => {
    const request = decodeChatRequest({
      ...base,
      messages: [
        { role: "system", content: "系统" },
        { role: "developer", name: "instructions", content: "开发者" },
        {
          role: "user",
          content: [
            { type: "text", text: "查看" },
            { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          reasoning_content: "分析",
          refusal: "拒绝内容",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "结果" }] },
      ],
      tools: [
        {
          type: "function",
          function: { name: "lookup", parameters: { type: "object" }, strict: false },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
    const encoded = encodeChatRequest(request);
    expect(encoded.messages[1]).toEqual({
      role: "developer",
      name: "instructions",
      content: [{ type: "text", text: "开发者" }],
    });
    expect(encoded.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "查看" },
        { type: "image_url", image_url: { url: "data:image/png;base64,YQ==", detail: "high" } },
      ],
    });
    expect(encoded.messages[3]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "分析",
      refusal: "拒绝内容",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"a"}' } },
      ],
    });
    expect(encoded.messages[4]).toEqual({ role: "tool", tool_call_id: "call_1", content: "结果" });
    expect(encoded.tools?.[0]?.function.strict).toBe(false);
    expect(encoded.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  it.each([undefined, null, false, true])("保留工具 strict 的缺省及显式值 %s", (strict) => {
    const encoded = encodeChatRequest(
      decodeChatRequest({
        ...base,
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: {},
              ...(strict === undefined ? {} : { strict }),
            },
          },
        ],
      }),
    );
    if (strict === undefined) expect(encoded.tools?.[0]?.function).not.toHaveProperty("strict");
    else expect(encoded.tools?.[0]?.function).toHaveProperty("strict", strict);
  });

  it.each([
    { type: "text" },
    { type: "json_object" },
    {
      type: "json_schema",
      json_schema: {
        name: "answer",
        description: "答案",
        schema: { type: "object", properties: {} },
        strict: false,
      },
    },
    { type: "json_schema", json_schema: { name: "answer", schema: {}, strict: true } },
    { type: "json_schema", json_schema: { name: "answer", schema: {} } },
  ])("保留结构化输出格式 $type", (response_format) => {
    expect(
      encodeChatRequest(decodeChatRequest({ ...base, response_format })).response_format,
    ).toEqual(response_format);
  });

  it("保留采样控制及同协议扩展，不透传未声明字段", () => {
    const controls = {
      temperature: 0.2,
      top_p: 0.8,
      frequency_penalty: 0.3,
      presence_penalty: -0.2,
      seed: 123,
      logit_bias: { "42": -10 },
      user: "user-a",
      safety_identifier: "safe-a",
      service_tier: "default",
      metadata: { tenant: "a" },
      store: false,
      reasoning_effort: "minimal",
      parallel_tool_calls: false,
    };
    const decoded = decodeChatRequest({ ...base, ...controls, stop: "END", max_tokens: 15 });
    const encoded = encodeChatRequest(decoded);
    expect(encoded).toMatchObject({ ...controls, max_tokens: 15, stop: ["END"] });
    expect(encoded).not.toHaveProperty("max_completion_tokens");
    decoded.extensions = {
      source: "openai-chat",
      request: { ...decoded.extensions?.request, untrusted: "secret" },
    };
    expect(encodeChatRequest(decoded)).not.toHaveProperty("untrusted");
  });

  it("新式词元限制保留 max_completion_tokens", () => {
    expect(
      encodeChatRequest(decodeChatRequest({ ...base, max_completion_tokens: 20 })),
    ).toHaveProperty("max_completion_tokens", 20);
  });

  it.each([true, false])("保留客户端 usage 意图 %s，但上游始终请求 usage", (include_usage) => {
    const request = decodeChatRequest({ ...base, stream: true, stream_options: { include_usage } });
    expect(request.extensions?.request?.stream_options).toEqual({ include_usage });
    expect(encodeChatRequest(request).stream_options).toEqual({ include_usage: true });
  });

  it.each(["explicit", "", null])("保留显式缓存键 %s", (prompt_cache_key) => {
    const request = decodeChatRequest({ ...base, prompt_cache_key });
    expect(request.extensions?.request).toHaveProperty("prompt_cache_key", prompt_cache_key);
    expect(encodeChatRequest(request)).toHaveProperty("prompt_cache_key", prompt_cache_key);
  });

  it("普通搜索函数仍作为客户端工具处理", () => {
    const request = decodeChatRequest({
      ...base,
      tools: [{ type: "function", function: { name: "web_search", parameters: {} } }],
    });
    expect(request.tools[0]).toMatchObject({ type: "function", name: "web_search" });
  });

  it.each([
    { n: 2 },
    { n: 0 },
    { audio: {} },
    { modalities: ["audio"] },
    { logprobs: false },
    { top_logprobs: 2 },
    { functions: [] },
    { function_call: "auto" },
    { web_search_options: {} },
    { unknown_secret: "不要回显" },
    { max_tokens: 5, max_completion_tokens: 10 },
    { max_tokens: -1 },
    { max_tokens: 1.5 },
    { temperature: 3 },
    { top_p: -1 },
    { frequency_penalty: -3 },
    { seed: 0.2 },
    { logit_bias: { "1": null } },
    { prompt_cache_key: 123 },
    { stream: "true" },
    { stream_options: { include_usage: "true" } },
    { stream_options: { other: true } },
    { messages: [] },
    { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "x", detail: "extreme" } }],
        },
      ],
    },
    { messages: [{ role: "assistant", content: "x", function_call: {} }] },
    { tools: [{ type: "web_search" }] },
    {
      tools: [
        { type: "function", function: { name: INTERNAL_WEB_SEARCH_TOOL_NAME, parameters: {} } },
      ],
    },
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: INTERNAL_WEB_SEARCH_TOOL_NAME, arguments: "{}" },
            },
          ],
        },
      ],
    },
    { tool_choice: { type: "function", function: { name: "missing" } } },
    {
      response_format: {
        type: "json_schema",
        json_schema: { name: "test", schema: {}, strict: "true" },
      },
    },
  ])("明确拒绝不支持或非法请求 %#", (fields) => {
    expect(() => decodeChatRequest({ ...base, ...fields })).toThrowError();
    try {
      decodeChatRequest({ ...base, ...fields });
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_OPENAI_CHAT_REQUEST" });
      expect((error as Error).message).not.toContain("不要回显");
    }
  });

  it("保留原有跨协议 developer 到 system 的映射", () => {
    const request = decodeChatRequest({
      ...base,
      messages: [{ role: "developer", content: "规则" }],
      response_format: { type: "json_object" },
    });
    request.source = "anthropic";
    expect(encodeChatRequest(request).messages[0]?.role).toBe("system");
    expect(encodeChatRequest(request)).not.toHaveProperty("response_format");
  });
});
