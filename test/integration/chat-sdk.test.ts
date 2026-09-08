import OpenAI from "openai";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Environment } from "../../src/config.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
function createApp(upstreamFetch: typeof fetch, environment: Environment = {}) {
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://gateway.example.test/v1", ...environment }),
    logger: false,
    upstreamFetch,
  });
  apps.push(app);
  return app;
}
async function createClient(upstreamFetch: typeof fetch) {
  const app = createApp(upstreamFetch);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("预期 TCP 监听地址");
  return new OpenAI({
    apiKey: "caller-key",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
  });
}
const usage = {
  prompt_tokens: 12,
  completion_tokens: 3,
  total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 1 },
};
function completion(
  message: Record<string, unknown> = { role: "assistant", content: "回答" },
  finish_reason = "stop",
) {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1234,
    model: "vendor/model",
    choices: [{ index: 0, message, finish_reason }],
    usage,
  };
}
function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return {
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 1234,
    model: "vendor/model",
    choices: [{ index: 0, delta, finish_reason }],
  };
}
function sse(values: Array<Record<string, unknown> | string>) {
  return new Response(
    values
      .map((data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const requestBody = {
  model: "vendor/model",
  messages: [
    { role: "system", content: "固定提示" },
    { role: "user", content: "问题" },
  ],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Chat 对外入口和官方 SDK", () => {
  it("SDK JSON 调用直接访问 Chat 并默认发送缓存键", async () => {
    let sent: Record<string, unknown> | undefined;
    const urls: string[] = [];
    const client = await createClient(async (input, init) => {
      const req = new Request(input, init);
      urls.push(req.url);
      expect(req.headers.get("authorization")).toBe("Bearer caller-key");
      sent = (await req.json()) as Record<string, unknown>;
      return Response.json(completion());
    });
    const result = await client.chat.completions.create({
      model: "vendor/model",
      messages: [
        { role: "developer", content: "固定提示" },
        { role: "user", content: "问题" },
      ],
    });
    expect(urls).toEqual(["https://gateway.example.test/v1/chat/completions"]);
    expect(sent?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(sent?.messages).toEqual([
      { role: "developer", content: [{ type: "text", text: "固定提示" }] },
      { role: "user", content: [{ type: "text", text: "问题" }] },
    ]);
    expect(result).toMatchObject({
      object: "chat.completion",
      created: 1234,
      choices: [{ message: { content: "回答" }, finish_reason: "stop" }],
      usage,
    });
  });

  it.each([
    true,
    false,
  ])("SDK 流式响应保留 refusal 和工具增量，include_usage=%s", async (includeUsage) => {
    let body: Record<string, unknown> | undefined;
    const client = await createClient(async (input, init) => {
      body = (await new Request(input, init).json()) as Record<string, unknown>;
      return sse([
        chunk({ role: "assistant", reasoning_content: "分析" }),
        chunk({ content: "答" }),
        chunk({ content: "案", refusal: "拒绝部分" }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "weather", arguments: '{"city":' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"上海"}' } }] }, "tool_calls"),
        { ...chunk({}), choices: [], usage },
        "[DONE]",
      ]);
    });
    const stream = await client.chat.completions.create({
      model: "vendor/model",
      messages: [
        { role: "system", content: "固定提示" },
        { role: "user", content: "问题" },
      ],
      stream: true,
      stream_options: { include_usage: includeUsage },
    });
    const received = [];
    for await (const event of stream) received.push(event);
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(body?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(received.map((event) => event.created)).toEqual(received.map(() => 1234));
    expect(received.map((event) => event.choices[0]?.delta.content ?? "").join("")).toBe("答案");
    expect(received.map((event) => event.choices[0]?.delta.refusal ?? "").join("")).toBe(
      "拒绝部分",
    );
    expect(
      received
        .flatMap((event) => event.choices[0]?.delta.tool_calls ?? [])
        .map((call) => call.function?.arguments ?? "")
        .join(""),
    ).toBe('{"city":"上海"}');
    expect(
      received.filter((event) => event.usage !== undefined && event.usage !== null),
    ).toHaveLength(includeUsage ? 1 : 0);
    if (includeUsage) expect(received.at(-1)?.usage).toEqual(usage);
  });

  it("SDK 保留图片 detail、工具 strict、结构化输出并支持工具结果回传", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const client = await createClient(async (input, init) => {
      sent.push((await new Request(input, init).json()) as Record<string, unknown>);
      return Response.json(
        sent.length === 1
          ? completion(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_a",
                    type: "function",
                    function: { name: "weather", arguments: "{}" },
                  },
                ],
              },
              "tool_calls",
            )
          : completion(),
      );
    });
    const first = await client.chat.completions.create({
      model: "vendor/model",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.test/image.png", detail: "low" },
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: { name: "weather", parameters: { type: "object" }, strict: false },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "weather_result", strict: false, schema: { type: "object" } },
      },
    });
    const assistantChoice = first.choices[0];
    if (!assistantChoice) throw new Error("预期上游返回单个候选答案");
    await client.chat.completions.create({
      model: "vendor/model",
      messages: [
        { role: "user", content: "天气" },
        assistantChoice.message,
        { role: "tool", tool_call_id: "call_a", content: "晴" },
      ],
    });
    expect(sent[0]?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.test/image.png", detail: "low" },
          },
        ],
      },
    ]);
    expect(sent[0]?.tools).toMatchObject([{ function: { strict: false } }]);
    expect(sent[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "weather_result", strict: false, schema: { type: "object" } },
    });
    expect(sent[1]?.messages).toContainEqual({
      role: "tool",
      tool_call_id: "call_a",
      content: "晴",
    });
  });

  it.each(["explicit", null])("JSON 与 SSE 均保留显式缓存键 %s", async (key) => {
    const sent: Array<Record<string, unknown>> = [];
    const app = createApp(async (input, init) => {
      const body = (await new Request(input, init).json()) as Record<string, unknown>;
      sent.push(body);
      return body.stream
        ? sse([chunk({ content: "回答" }, "stop"), "[DONE]"])
        : Response.json(completion());
    });
    for (const stream of [false, true]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer key" },
        payload: { ...requestBody, stream, prompt_cache_key: key },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(sent.map((body) => body.prompt_cache_key)).toEqual([key, key]);
  });

  it.each([401, 429, 500])("上游 %s 不触发其他接口或重试，且清洗错误", async (status) => {
    let calls = 0;
    const app = createApp(async () => {
      calls++;
      return Response.json(
        { error: { message: "秘密上游正文", code: "private_code" } },
        { status },
      );
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: requestBody,
    });
    expect(response.statusCode).toBe(status);
    expect(calls).toBe(1);
    expect(response.json()).toHaveProperty("error");
    expect(response.body).not.toContain("秘密");
    expect(response.body).not.toContain("private_code");
  });

  it("缺少鉴权、浅层校验及请求体超限均使用 OpenAI 错误外壳", async () => {
    let calls = 0;
    const app = createApp(
      async () => {
        calls++;
        return Response.json(completion());
      },
      { BODY_LIMIT_BYTES: "256" },
    );
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: requestBody,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error.type).toBe("authentication_error");
    for (const [payload, status] of [
      [{ model: 1 }, 400],
      [{ ...requestBody, messages: [{ role: "user", content: "秘密".repeat(1000) }] }, 413],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions?x=1",
        headers: { authorization: "Bearer key" },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json().error.type).toBe("invalid_request_error");
      expect(response.json()).not.toHaveProperty("type");
      expect(response.body).not.toContain("秘密");
    }
    expect(calls).toBe(0);
  });

  it.each([
    { n: 2 },
    { audio: {} },
    { logprobs: true },
    { functions: [] },
    { web_search_options: {} },
    { max_tokens: 1, max_completion_tokens: 2 },
  ])("不支持的请求在上游调用前拒绝：%j", async (extra) => {
    let calls = 0;
    const app = createApp(async () => {
      calls++;
      return Response.json(completion());
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: { ...requestBody, ...extra },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(calls).toBe(0);
  });

  it.each([
    "malformed",
    "missing-done",
    "too-large",
    "error",
  ])("流异常 %s 不输出成功结束标记", async (failure) => {
    const tail: Array<Record<string, unknown> | string> =
      failure === "malformed"
        ? ["秘密非法JSON"]
        : failure === "too-large"
          ? [chunk({ content: "超".repeat(1000) })]
          : failure === "error"
            ? [{ error: { code: "秘密代码", message: "秘密正文" } }]
            : [];
    const app = createApp(async () => sse([chunk({ content: "正常前缀" }), ...tail]), {
      UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "512",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: { ...requestBody, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("正常前缀");
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain("[DONE]");
    expect(response.body).not.toContain("秘密");
  });

  it.each([false, true])("首字节或空闲超时会取消上游，已开始=%s", async (started) => {
    let aborted = false;
    const app = createApp(
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (started)
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify(chunk({ content: "前缀" }))}\n\n`,
                  ),
                );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "100", UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "20" },
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: { ...requestBody, stream: true },
    });
    expect(response.statusCode).toBe(started ? 200 : 500);
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain("[DONE]");
    expect(aborted).toBe(true);
  });

  it.each([false, true])("真实客户端断连会取消上游，stream=%s", async (stream) => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const app = createApp(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new Error("已取消上游")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": stream ? "text/event-stream" : "application/json" } },
      );
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("预期 TCP 监听地址");
    const body = JSON.stringify({ ...requestBody, stream });
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        authorization: "Bearer key",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    });
    client.on("error", () => undefined);
    client.end(body);
    try {
      await started.promise;
      client.destroy();
      await expect(aborted.promise).resolves.toBeUndefined();
    } finally {
      client.destroy();
    }
  });

  it("拒绝内容在 Messages 的 Chat 回退路径仍能正常结束", async () => {
    const app = createApp(async (input) =>
      String(input).endsWith("responses")
        ? Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 })
        : sse([chunk({ refusal: "拒绝" }), chunk({ refusal: "回答" }, "content_filter"), "[DONE]"]),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "key" },
      payload: {
        model: "vendor/model",
        messages: [{ role: "user", content: "问题" }],
        max_tokens: 32,
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"text":"拒绝"');
    expect(response.body).toContain('"text":"回答"');
    expect(response.body).toContain('"stop_reason":"refusal"');
    expect(response.body).toContain("event: message_stop");
    expect(response.body).not.toContain("event: error");
  });

  it.each([false, true])("Chat 直连保留被截断的工具参数及 length，stream=%s", async (stream) => {
    const tool_calls = [
      { id: "call_cut", type: "function", function: { name: "weather", arguments: '{"city":' } },
    ];
    const app = createApp(async () =>
      stream
        ? sse([
            chunk({ tool_calls: tool_calls.map((call) => ({ ...call, index: 0 })) }, "length"),
            "[DONE]",
          ])
        : Response.json(completion({ role: "assistant", content: null, tool_calls }, "length")),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: { ...requestBody, stream },
    });
    expect(response.statusCode, response.body).toBe(200);
    if (stream) {
      expect(response.body).toContain('"finish_reason":"length"');
      expect(response.body).toContain("data: [DONE]\n\n");
      expect(response.body).not.toContain('"error"');
    } else {
      expect(response.json().choices[0]).toMatchObject({
        message: { tool_calls },
        finish_reason: "length",
      });
    }
  });

  it("DONE 后的非法上游数据不能被当作成功响应结束", async () => {
    const app = createApp(async () =>
      sse([chunk({ content: "回答" }, "stop"), "[DONE]", "非法尾部"]),
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer key" },
      payload: { ...requestBody, stream: true },
    });
    expect(response.body).toContain('"error"');
    expect(response.body).not.toContain("data: [DONE]");
    expect(response.body).not.toContain("非法尾部");
  });
});
