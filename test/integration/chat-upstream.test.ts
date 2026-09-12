import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { chatStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function answer(message: Wire = { role: "assistant", content: "答案" }, finishReason = "stop") {
  return {
    id: "chat_upstream",
    model: "m",
    created: 123,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
  };
}

function setup(
  respond: (body: Wire, round: number) => Response = (body) =>
    body.stream ? chatStream(answer()) : Response.json(answer()),
  options: Partial<Parameters<typeof buildApp>[0]> = {},
) {
  const sent: Array<{ url: string; body: Wire; authorization: string | null }> = [];
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream-a.test/v1" }),
    logger: false,
    ...options,
    upstreamFetch: async (url, init) => {
      const request = new Request(url, init);
      const body = (await request.json()) as Wire;
      sent.push({ url: request.url, body, authorization: request.headers.get("authorization") });
      return respond(body, sent.length);
    },
  });
  apps.push(app);
  return { app, sent };
}

function frames(body: string): Wire[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as Wire);
}

function terminal(body: string, stream: boolean): Wire {
  if (!stream) return JSON.parse(body) as Wire;
  return frames(body).findLast(
    (frame) => frame.type === "response.completed" || frame.type === "response.incomplete",
  )?.response as Wire;
}

const headers = { authorization: "Bearer caller-key" };

describe("默认强制 Chat 上游", () => {
  it.each([
    "/v1/messages",
    "/v1/responses",
    "/v1/chat/completions",
  ])("%s 的 JSON/SSE 只发 Chat，保留凭据与稳定缓存键", async (url) => {
    const { app, sent } = setup();
    for (const stream of [false, true]) {
      const result = await app.inject({
        method: "POST",
        url,
        headers,
        payload:
          url === "/v1/responses"
            ? { model: "m", instructions: "固定提示", input: "问题", stream }
            : url === "/v1/messages"
              ? {
                  model: "m",
                  max_tokens: 32,
                  system: "固定提示",
                  messages: [{ role: "user", content: "问题" }],
                  stream,
                }
              : {
                  model: "m",
                  messages: [
                    { role: "system", content: "固定提示" },
                    { role: "user", content: "问题" },
                  ],
                  stream,
                },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.body).toContain("答案");
      expect(sent.at(-1)).toMatchObject({
        url: "https://upstream-a.test/v1/chat/completions",
        authorization: "Bearer caller-key",
      });
      expect(sent.at(-1)?.body).not.toHaveProperty("input");
    }
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(sent[1]?.body.prompt_cache_key).toBe(sent[0]?.body.prompt_cache_key);
    expect(sent[1]?.body.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    false,
    true,
  ])("Responses 显式缓存键、null、用量转换与独立输出 ID，stream=%s", async (stream) => {
    const { app, sent } = setup();
    const ids = new Set();
    for (const key of ["session-key", null]) {
      const result = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers,
        payload: {
          model: "m",
          instructions: "固定提示",
          input: "问题",
          stream,
          prompt_cache_key: key,
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(sent.at(-1)?.body.prompt_cache_key).toBe(key);
      const response = terminal(result.body, stream);
      expect(response).toMatchObject({
        object: "response",
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 70, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      });
      const output = response.output as Wire[];
      expect(response.id).toMatch(/^resp_/);
      expect(output[0]?.id).toMatch(/^msg_/);
      expect(output[0]).toMatchObject({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "答案" }],
      });
      ids.add(output[0]?.id);
    }
    expect(ids.size).toBe(2);
  });

  it.each([
    false,
    true,
  ])("Responses 推理和并行工具输出支持 item_reference 续轮，stream=%s", async (stream) => {
    const initial = answer(
      {
        role: "assistant",
        reasoning_content: "先查询",
        content: "开始",
        tool_calls: ["a", "b"].map((id) => ({
          id,
          type: "function",
          function: { name: "lookup", arguments: JSON.stringify({ id }) },
        })),
      },
      "tool_calls",
    );
    const { app, sent } = setup((body, round) => {
      const response = round === 1 ? initial : answer();
      return body.stream ? chatStream(response) : Response.json(response);
    });
    const base = { model: "m", instructions: "固定提示", stream };
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { ...base, input: "问题" },
    });
    expect(first.statusCode, first.body).toBe(200);
    const output = terminal(first.body, stream).output as Wire[];
    expect(output.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call",
    ]);
    expect(output[0]).toMatchObject({ summary: [{ type: "summary_text", text: "先查询" }] });
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        ...base,
        input: [
          { role: "user", content: "问题" },
          ...output.map((item) => ({ type: "item_reference", id: item.id })),
          { type: "function_call_output", call_id: "a", output: "结果 A" },
          { type: "function_call_output", call_id: "b", output: "结果 B" },
        ],
      },
    });
    expect(second.statusCode, second.body).toBe(200);
    const messages = sent[1]?.body.messages as Wire[];
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(messages.find((message) => message.role === "assistant")).toMatchObject({
      reasoning_content: "先查询",
      tool_calls: [{ id: "a" }, { id: "b" }],
    });
    expect(messages.slice(-2)).toEqual([
      { role: "tool", tool_call_id: "a", content: "结果 A" },
      { role: "tool", tool_call_id: "b", content: "结果 B" },
    ]);
    expect(sent[1]?.body.prompt_cache_key).toBe(sent[0]?.body.prompt_cache_key);
  });

  it.each([
    false,
    true,
  ])("映射 Responses 的格式、推理参数、图片精度和自定义 web_search 选择，stream=%s", async (stream) => {
    const { app, sent } = setup();
    const format = {
      type: "json_schema",
      name: "answer",
      description: "结果",
      strict: false,
      schema: { type: "object" },
    };
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "m",
        stream,
        max_output_tokens: 99,
        reasoning: { effort: "high", summary: "auto" },
        text: { format, verbosity: "low" },
        parallel_tool_calls: false,
        metadata: { tag: "test" },
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_image", image_url: "https://image.test/a.png", detail: "high" },
            ],
          },
        ],
        tools: [
          { type: "function", name: "web_search", parameters: { type: "object" } },
          { type: "web_search" },
        ],
        tool_choice: { type: "function", name: "web_search" },
        include: ["reasoning.encrypted_content"],
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(sent[0]?.body).toMatchObject({
      max_completion_tokens: 99,
      reasoning_effort: "high",
      verbosity: "low",
      store: false,
      parallel_tool_calls: false,
      metadata: { tag: "test" },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "结果",
          strict: false,
          schema: { type: "object" },
        },
      },
      tool_choice: { type: "function", function: { name: "web_search" } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://image.test/a.png", detail: "high" } },
          ],
        },
      ],
    });
    expect(sent[0]?.body).not.toHaveProperty("include");
    expect(sent[0]?.body).not.toHaveProperty("reasoning");
  });

  it.each([
    false,
    true,
  ])("保留截断工具参数并返回 response.incomplete，stream=%s", async (stream) => {
    const response = answer(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_a",
            type: "function",
            function: { name: "lookup", arguments: '{"partial":' },
          },
        ],
      },
      "length",
    );
    const { app } = setup((body) => (body.stream ? chatStream(response) : Response.json(response)));
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: "问题", stream },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(terminal(result.body, stream)).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", arguments: '{"partial":', status: "incomplete" }],
    });
  });

  it.each([false, true])("返回拒绝内容，且不伪造上游缺失的缓存用量，stream=%s", async (stream) => {
    const response = {
      ...answer({ role: "assistant", content: null, refusal: "无法回答" }, "content_filter"),
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    };
    const { app } = setup((body) => (body.stream ? chatStream(response) : Response.json(response)));
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: "问题", stream },
    });
    expect(result.statusCode, result.body).toBe(200);
    const final = terminal(result.body, stream);
    expect(final).toMatchObject({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "无法回答" }] }],
    });
    expect(final.usage).not.toHaveProperty("input_tokens_details");
  });

  it.each([
    false,
    true,
  ])("成功工具调用的损坏参数不能作为有效 Responses 返回，stream=%s", async (stream) => {
    const response = answer(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "lookup", arguments: '{"broken":' },
          },
        ],
      },
      "tool_calls",
    );
    const { app, sent } = setup((body) =>
      body.stream ? chatStream(response) : Response.json(response),
    );
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: "问题", stream },
    });
    if (stream && result.statusCode === 200) {
      expect(result.body).toContain("event: error");
      expect(terminal(result.body, true)).toBeUndefined();
    } else expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(sent).toHaveLength(1);
  });

  it("Chat 流在 DONE 后仍有错误时不发送成功终态，也不缓存已输出的项", async () => {
    const valid = await chatStream(answer()).text();
    const { app, sent } = setup(
      () =>
        new Response(`${valid}data: {"unexpected":true}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: "问题", stream: true },
    });
    expect(result.body).toContain("event: error");
    expect(terminal(result.body, true)).toBeUndefined();
    const item = frames(result.body).find((frame) => frame.type === "response.output_item.done")
      ?.item as Wire;
    expect(item.id).toMatch(/^msg_/);
    const continuation = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: [{ type: "item_reference", id: item.id }] },
    });
    expect(continuation.statusCode).toBe(400);
    expect(continuation.json().error.code).toBe("reference_cache_miss");
    expect(sent).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])("Responses 内置搜索仍由网关执行，搜索续轮走 Chat 并累计缓存用量，stream=%s", async (stream) => {
    const { app, sent } = setup(
      (body, round) => {
        const response =
          round === 1
            ? answer(
                {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "search_a",
                      type: "function",
                      function: {
                        name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                        arguments: '{"query":"资料"}',
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : answer({ role: "assistant", content: "[资料](https://source.test/page)" });
        return body.stream ? chatStream(response) : Response.json(response);
      },
      {
        webSearchProvider: {
          capabilities: () => ({ execute: true, citations: true, streaming: true }),
          execute: async () => [
            { title: "资料", url: "https://source.test/page", content: "正文" },
          ],
        },
      },
    );
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "m",
        input: "搜索资料",
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
        stream,
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    const response = terminal(result.body, stream);
    expect(response).toMatchObject({
      status: "completed",
      usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 140 } },
      output: [
        {
          type: "web_search_call",
          action: { sources: [{ type: "url", url: "https://source.test/page" }] },
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              annotations: [{ type: "url_citation", url: "https://source.test/page" }],
            },
          ],
        },
      ],
    });
    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.url.endsWith("/chat/completions"))).toBe(true);
    expect(sent[1]?.body.prompt_cache_key).toBe(sent[0]?.body.prompt_cache_key);
  });

  it.each([404, 405, 429, 500, 501])("Chat HTTP %s 不尝试 Responses 或重试", async (status) => {
    for (const stream of [false, true]) {
      for (const url of ["/v1/messages", "/v1/responses"]) {
        const { app, sent } = setup(() =>
          Response.json({ error: { code: "endpoint_not_found" } }, { status }),
        );
        const result = await app.inject({
          method: "POST",
          url,
          headers,
          payload:
            url === "/v1/messages"
              ? {
                  model: "m",
                  max_tokens: 32,
                  messages: [{ role: "user", content: "问题" }],
                  stream,
                }
              : { model: "m", input: "问题", stream },
        });
        expect(result.statusCode).toBeGreaterThanOrEqual(400);
        expect(sent.map((request) => request.url)).toEqual([
          "https://upstream-a.test/v1/chat/completions",
        ]);
      }
    }
  });

  it("count_tokens 不访问 Responses，也不通过生成请求估算", async () => {
    const { app, sent } = setup();
    const result = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers,
      payload: { model: "m", messages: [{ role: "user", content: "问题" }] },
    });
    expect(result.statusCode).toBe(501);
    expect(sent).toHaveLength(0);
  });

  it.each([
    { previous_response_id: "resp_old" },
    { reasoning: { effort: ["high"] } },
    { input: [{ type: "reasoning", id: "rs_old", summary: [], encrypted_content: "opaque" }] },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://image.test/a", detail: "original" }],
        },
      ],
    },
  ])("无法表达的 Responses 请求在访问上游之前返回 400：%j", async (extra) => {
    const { app, sent } = setup();
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", input: "问题", ...extra },
    });
    expect(result.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("OpenAI SDK 可以读取 JSON 和流式 Responses 回包", async () => {
    const { app, sent } = setup();
    const client = new OpenAI({
      apiKey: "caller-key",
      baseURL: "http://gateway.test/v1",
      maxRetries: 0,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const result = await app.inject({
          method: "POST",
          url: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers),
          payload: await request.text(),
        });
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "content-type": String(result.headers["content-type"]) },
        });
      },
    });
    const response = await client.responses.create({ model: "m", input: "问题" });
    expect(response.output_text).toBe("答案");
    const stream = await client.responses.create({ model: "m", input: "问题", stream: true });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.some((event) => event.type === "response.completed")).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("客户端断开 Responses SSE 后取消 Chat 上游", async () => {
    let upstreamAborted = false;
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream-a.test/v1" }),
      logger: false,
      upstreamFetch: async (url, init) => {
        expect(String(url)).toBe("https://upstream-a.test/v1/chat/completions");
        init?.signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
          },
          { once: true },
        );
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"id":"chat_live","model":"m","choices":[{"index":0,"delta":{"content":"开始"},"finish_reason":null}]}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/v1/responses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "问题", stream: true }),
    });
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("Expected a Responses stream body");
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
  });
});
