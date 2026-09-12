import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import type { WebSearchProvider, WebSearchRequest } from "../../src/providers/web-search/types.js";
import { chatStream, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: ReturnType<typeof buildApp>[] = [];
const headers = { authorization: "Bearer test-key" };
const answer = {
  id: "resp_answer",
  object: "response",
  model: "model-test",
  status: "completed",
  output: [
    {
      id: "msg_answer",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "已处理", annotations: [] }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 2 },
};
const chatAnswer = {
  id: "chat_answer",
  object: "chat.completion",
  model: "model-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "已处理" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(options: { fallback?: boolean; webSearchProvider?: WebSearchProvider } = {}) {
  const requests: { path: string; body: Wire }[] = [];
  const upstreamFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(init?.body as string) as Wire;
    requests.push({ path, body });
    if (options.fallback && path === "/v1/responses") {
      return Response.json({ error: { code: "endpoint_not_found" } }, { status: 404 });
    }
    if (path === "/v1/chat/completions") {
      return body.stream ? chatStream(chatAnswer) : Response.json(chatAnswer);
    }
    const response =
      options.webSearchProvider && requests.length === 1
        ? {
            ...answer,
            id: "resp_search",
            output: [
              {
                id: "fc_search",
                type: "function_call",
                call_id: "call_search",
                name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                arguments: '{"query":"当地资料"}',
                status: "completed",
              },
            ],
          }
        : answer;
    return body.stream ? responsesStream(response) : Response.json(response);
  });
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch,
    ...(options.webSearchProvider ? { webSearchProvider: options.webSearchProvider } : {}),
  });
  apps.push(app);
  return { app, requests, upstreamFetch };
}

function expectCompleted(response: { statusCode: number; body: string }, stream: boolean) {
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain("已处理");
  if (stream) {
    expect(response.body).not.toContain("event: error");
    expect(response.body).toMatch(/event: (response.completed|message_stop)/);
  }
}

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const textOptions = [
  { format: { type: "text" }, verbosity: "low" },
  { format: { type: "json_object" }, verbosity: "medium" },
  ...[undefined, null, false, true].map((strict) => ({
    format: {
      type: "json_schema",
      name: "answer",
      description: "回答结构",
      schema,
      ...(strict === undefined ? {} : { strict }),
    },
    verbosity: "high",
  })),
];

describe("协议转换缺口 HTTP 回归", () => {
  it.each(
    [false, true].flatMap((stream) => textOptions.map((text) => ({ stream, text }))),
  )("Responses 保留文本格式、严格模式及详细程度 %j", async ({ stream, text }) => {
    const { app, requests } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "model-test", input: "回答", text, stream },
    });
    expectCompleted(response, stream);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.text).toEqual(text);
  });

  it.each([
    { format: "json_object" },
    { format: { type: "unknown" } },
    { format: { type: "text", schema } },
    { format: { type: "json_schema", name: "answer" } },
    { format: { type: "json_schema", name: "answer", schema, strict: "true" } },
    { format: { type: "json_schema", name: "answer", schema, description: 1 } },
    { format: { type: "json_schema", name: "answer", schema, unsupported: true } },
    { format: { type: "text" }, verbosity: "unknown" },
    { format: { type: "text" }, unsupported: true },
  ])("非法 text 嵌套字段在访问上游前返回 400：%j", async (text) => {
    const { app, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "model-test", input: "回答", text },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.type).toBe("invalid_request_error");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("Responses 图片精度原样传递，流式=%s", async (stream) => {
    const { app, requests } = setup();
    const content = ["low", "high", "original"].map((detail) => ({
      type: "input_image",
      image_url: `https://image.test/${detail}.png`,
      detail,
    }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "model-test",
        input: [{ role: "user", content }],
        stream,
      },
    });
    expectCompleted(response, stream);
    expect(requests).toHaveLength(1);
    expect((requests[0]?.body.input as Wire[])[0]?.content).toEqual(content);
  });

  it.each(["invalid", 1, false, {}])("非法图片精度返回 400 且不访问上游：%j", async (detail) => {
    const { app, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "model-test",
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://image.test/a.png", detail }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each(
    [false, true].flatMap((stream) => [false, true].map((filtered) => ({ stream, filtered }))),
  )("Responses 工具 strict 保留原值且过滤后不串位 %j", async ({ stream, filtered }) => {
    const { app, requests } = setup();
    const tools = [true, undefined, null, false].map((strict, index) => ({
      type: "function",
      name: `tool_${index}`,
      description: `工具 ${index}`,
      parameters: { type: "object", properties: {} },
      ...(strict === undefined ? {} : { strict }),
    }));
    const retained = filtered ? tools.slice(1) : tools;
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "model-test",
        input: "回答",
        stream,
        tools,
        ...(filtered
          ? {
              tool_choice: {
                type: "allowed_tools",
                mode: "auto",
                tools: retained.map(({ name }) => ({ type: "function", name })),
              },
            }
          : {}),
      },
    });
    expectCompleted(response, stream);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.tools).toEqual(retained);
  });

  it.each(
    [false, true].flatMap((stream) =>
      [false, true].flatMap((fallback) =>
        [undefined, false, true].map((isError) => ({ stream, fallback, isError })),
      ),
    ),
  )("Anthropic 工具结果保留失败语义，成功结果保持原文 %j", async ({
    stream,
    fallback,
    isError,
  }) => {
    const { app, requests } = setup({ fallback });
    const output = '第一行结果\n第二行包含引号："原文"';
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: {
        model: "model-test",
        max_tokens: 100,
        stream,
        tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "查询" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_lookup", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_lookup",
                content: output,
                ...(isError === undefined ? {} : { is_error: isError }),
              },
            ],
          },
        ],
      },
    });
    expectCompleted(response, stream);
    expect(requests.map(({ path }) => path)).toEqual(
      fallback ? ["/v1/responses", "/v1/chat/completions"] : ["/v1/responses"],
    );
    const expected = isError ? JSON.stringify({ is_error: true, output }) : output;
    expect(requests[0]?.body.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_lookup",
      output: expected,
    });
    if (fallback) {
      expect(requests[1]?.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_lookup",
        content: expected,
      });
    }
  });

  it.each([false, true])("Anthropic 混合文本和工具历史保持出现顺序，流式=%s", async (stream) => {
    const { app, requests } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: {
        model: "model-test",
        max_tokens: 100,
        stream,
        tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
        messages: [
          { role: "user", content: "查询" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "前文" },
              { type: "tool_use", id: "call_lookup", name: "lookup", input: {} },
              { type: "text", text: "后文" },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_lookup", content: "结果" }],
          },
        ],
      },
    });
    expectCompleted(response, stream);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "查询" }] },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "前文" }] },
      { type: "function_call", call_id: "call_lookup", name: "lookup", arguments: "{}" },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "后文" }] },
      { type: "function_call_output", call_id: "call_lookup", output: "结果" },
    ]);
  });

  it.each(
    [false, true].flatMap((stream) =>
      [
        {
          location: {
            type: "approximate",
            city: "上海",
            country: "CN",
            region: "上海市",
            timezone: "Asia/Shanghai",
          },
          expected: { city: "上海", country: "CN", region: "上海市", timezone: "Asia/Shanghai" },
        },
        {
          location: {
            type: "approximate",
            city: "上海",
            country: "CN",
            region: null,
            timezone: null,
          },
          expected: { city: "上海", country: "CN" },
        },
      ].map((location) => ({ stream, ...location })),
    ),
  )("Anthropic 搜索位置传至实际提供方并丢弃空子字段 %j", async ({ stream, location, expected }) => {
    const execute = vi.fn(async (_request: WebSearchRequest) => [
      { title: "当地资料", url: "https://example.test/doc", content: "查询结果" },
    ]);
    const { app, requests } = setup({
      webSearchProvider: {
        capabilities: () => ({ execute: true, streaming: false, citations: false }),
        execute,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: {
        model: "model-test",
        max_tokens: 100,
        stream,
        messages: [{ role: "user", content: "搜索当地资料" }],
        tools: [{ type: "web_search_20250305", name: "web_search", user_location: location }],
      },
    });
    expectCompleted(response, stream);
    expect(requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ query: "当地资料" });
    expect(execute.mock.calls[0]?.[0].userLocation).toEqual(expected);
    expect(JSON.stringify(requests[1]?.body.input)).toContain("查询结果");
  });
});
