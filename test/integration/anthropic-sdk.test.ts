import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";
import { responsesStream } from "../helpers/upstream.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

function createApp(upstreamFetch: typeof globalThis.fetch) {
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://gateway.example.test/v1" }),
    logger: false,
    upstreamFetch,
  });
  apps.push(app);
  return app;
}

function createResponsesStream(
  events: ReadonlyArray<{ event: string; data: Record<string, unknown> }>,
): Response {
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function createAnthropicClient(upstreamFetch: typeof globalThis.fetch, userAgent?: string) {
  const app = createApp(upstreamFetch);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("预期 Fastify 监听 TCP 地址");
  }

  return new Anthropic({
    apiKey: "caller-key",
    authToken: null,
    baseURL: `http://127.0.0.1:${address.port}`,
    maxRetries: 0,
    ...(userAgent === undefined ? {} : { defaultHeaders: { "user-agent": userAgent } }),
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Anthropic SDK 兼容性", () => {
  it("通过高级流聚合完整的 Web Search 引用", async () => {
    const client = await createAnthropicClient(async () =>
      responsesStream({
        id: "resp_sdk_citation",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_sdk_citation",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "A cited answer.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "Source",
                    start_index: 2,
                    end_index: 7,
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 3 },
      }),
    );
    const message = await client.messages
      .stream({
        model: "vendor/model-1",
        max_tokens: 64,
        messages: [{ role: "user", content: "answer with a citation" }],
      })
      .finalMessage();

    expect(message.content).toEqual([
      {
        type: "text",
        text: "A cited answer.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.test/source",
            title: "Source",
            cited_text: "cited",
            encrypted_index: "",
          },
        ],
      },
    ]);
  });

  it("通过 SDK messages.create 处理工具请求和响应", async () => {
    let upstreamRequest: Request | undefined;
    const client = await createAnthropicClient(async (input, init) => {
      upstreamRequest = new Request(input, init);
      return Response.json({
        id: "resp_sdk_tool",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Checking the weather.", annotations: [] }],
          },
          {
            type: "function_call",
            id: "fc_sdk_weather",
            call_id: "toolu_sdk_weather",
            name: "weather",
            arguments: '{"city":"Paris"}',
          },
        ],
        usage: { input_tokens: 12, output_tokens: 6 },
      });
    });

    const message = await client.messages.create({
      model: "vendor/model-1",
      max_tokens: 128,
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
      tools: [
        {
          name: "weather",
          description: "Get the weather for a city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: {
        type: "tool",
        name: "weather",
        disable_parallel_tool_use: true,
      },
    });

    expect(message).toMatchObject({
      id: "resp_sdk_tool",
      type: "message",
      role: "assistant",
      model: "vendor/model-1",
      content: [
        { type: "text", text: "Checking the weather." },
        {
          type: "tool_use",
          id: "toolu_sdk_weather",
          name: "weather",
          input: { city: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 6 },
    });
    expect(upstreamRequest?.url).toBe("https://gateway.example.test/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer caller-key");
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-1",
      max_output_tokens: 128,
      stream: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What is the weather in Paris?" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get the weather for a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: false,
    });
  });

  it("通过高级流聚合 thinking、文本和分片工具参数", async () => {
    let upstreamRequest: Request | undefined;
    const client = await createAnthropicClient(async (input, init) => {
      upstreamRequest = new Request(input, init);
      return createResponsesStream([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: { id: "resp_sdk_stream", model: "vendor/model-1" },
          },
        },
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "reasoning", id: "reasoning_sdk", summary: [] },
          },
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: {
            type: "response.reasoning_summary_text.delta",
            output_index: 0,
            delta: "plan",
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "reasoning_sdk",
              summary: [{ type: "summary_text", text: "plan" }],
            },
          },
        },
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              type: "message",
              id: "msg_sdk_stream",
              role: "assistant",
              content: [],
            },
          },
        },
        {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            output_index: 1,
            content_index: 0,
            delta: "Checking the weather.",
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "message",
              id: "msg_sdk_stream",
              role: "assistant",
              content: [{ type: "output_text", text: "Checking the weather.", annotations: [] }],
            },
          },
        },
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 2,
            item: {
              type: "function_call",
              id: "fc_sdk_stream",
              call_id: "toolu_sdk_stream",
              name: "weather",
              arguments: "",
            },
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            output_index: 2,
            delta: '{"city":',
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            type: "response.function_call_arguments.delta",
            output_index: 2,
            delta: '"Paris"}',
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 2,
            item: {
              type: "function_call",
              id: "fc_sdk_stream",
              call_id: "toolu_sdk_stream",
              name: "weather",
              arguments: '{"city":"Paris"}',
            },
          },
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_sdk_stream",
              model: "vendor/model-1",
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 7 },
            },
          },
        },
      ]);
    }, "claude-cli/2.1.220 (external, cli)");

    const stream = client.messages.stream({
      model: "vendor/model-1",
      max_tokens: 128,
      messages: [{ role: "user", content: "Check the weather." }],
      tools: [
        {
          name: "weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });
    const eventTypes: string[] = [];
    const deltaTypes: string[] = [];
    const thinkingDeltas: string[] = [];
    const textDeltas: string[] = [];
    const signatureDeltas: string[] = [];
    const inputJsonDeltas: string[] = [];
    const completedBlockTypes: string[] = [];
    const completedMessages: unknown[] = [];

    stream
      .on("thinking", (delta) => thinkingDeltas.push(delta))
      .on("text", (delta) => textDeltas.push(delta))
      .on("signature", (signature) => signatureDeltas.push(signature))
      .on("inputJson", (delta) => inputJsonDeltas.push(delta))
      .on("contentBlock", (block) => completedBlockTypes.push(block.type))
      .on("message", (message) => completedMessages.push(message));

    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "content_block_delta") {
        deltaTypes.push(event.delta.type);
      }
    }
    const message = await stream.finalMessage();
    const signature = signatureDeltas[0] ?? "";

    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(deltaTypes).toEqual([
      "thinking_delta",
      "signature_delta",
      "text_delta",
      "input_json_delta",
      "input_json_delta",
    ]);
    expect(thinkingDeltas).toEqual(["plan"]);
    expect(textDeltas).toEqual(["Checking the weather."]);
    expect(signature).toMatch(/^[A-Za-z0-9+/]{48}$/);
    expect(inputJsonDeltas).toEqual(['{"city":', '"Paris"}']);
    expect(completedBlockTypes).toEqual(["thinking", "text", "tool_use"]);
    expect(completedMessages).toHaveLength(1);
    expect(message).toMatchObject({
      id: "resp_sdk_stream",
      type: "message",
      role: "assistant",
      model: "vendor/model-1",
      content: [
        { type: "thinking", thinking: "plan", signature },
        { type: "text", text: "Checking the weather." },
        {
          type: "tool_use",
          id: "toolu_sdk_stream",
          name: "weather",
          input: { city: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 7 },
    });
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-1",
      max_output_tokens: 128,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Check the weather." }],
        },
      ],
      tools: [{ type: "function", name: "weather" }],
    });
  });

  it("通过 messages.create 的 stream:true 读取原始事件", async () => {
    let upstreamRequest: Request | undefined;
    const client = await createAnthropicClient(async (input, init) => {
      upstreamRequest = new Request(input, init);
      return createResponsesStream([
        {
          event: "response.created",
          data: {
            type: "response.created",
            response: { id: "resp_sdk_raw", model: "vendor/model-1" },
          },
        },
        {
          event: "response.output_item.added",
          data: {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_sdk_raw",
              role: "assistant",
              content: [],
            },
          },
        },
        {
          event: "response.output_text.delta",
          data: {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta: "raw stream",
          },
        },
        {
          event: "response.output_item.done",
          data: {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_sdk_raw",
              role: "assistant",
              content: [{ type: "output_text", text: "raw stream", annotations: [] }],
            },
          },
        },
        {
          event: "response.completed",
          data: {
            type: "response.completed",
            response: {
              id: "resp_sdk_raw",
              model: "vendor/model-1",
              status: "completed",
              output: [],
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          },
        },
      ]);
    });

    const stream = await client.messages.create({
      model: "vendor/model-1",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Use the raw stream." }],
    });
    const eventTypes: string[] = [];
    const textDeltas: string[] = [];

    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        textDeltas.push(event.delta.text);
      }
    }

    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(textDeltas).toEqual(["raw stream"]);
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-1",
      max_output_tokens: 64,
      stream: true,
    });
  });

  it("通过 SDK messages.countTokens 转换 token 计数请求", async () => {
    let upstreamRequest: Request | undefined;
    const client = await createAnthropicClient(async (input, init) => {
      upstreamRequest = new Request(input, init);
      return Response.json({ object: "response.input_tokens", input_tokens: 42 });
    });

    const result = await client.messages.countTokens({
      model: "vendor/model-1",
      system: "Be concise.",
      messages: [{ role: "user", content: "Count this request." }],
      tools: [
        {
          name: "weather",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });

    expect(result).toEqual({ input_tokens: 42 });
    expect(upstreamRequest?.url).toBe("https://gateway.example.test/v1/responses/input_tokens");
    const upstreamBody = await upstreamRequest?.json();
    expect(upstreamBody).toMatchObject({
      model: "vendor/model-1",
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "Be concise." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Count this request." }],
        },
      ],
      tools: [{ type: "function", name: "weather" }],
    });
    expect(upstreamBody).not.toHaveProperty("store");
    expect(upstreamBody).not.toHaveProperty("stream");
  });

  it.each([
    {
      status: 401,
      type: "authentication_error",
      errorClass: Anthropic.AuthenticationError,
    },
    {
      status: 429,
      type: "rate_limit_error",
      errorClass: Anthropic.RateLimitError,
    },
  ] as const)("将上游 HTTP $status 映射为官方 SDK 错误类", async (testCase) => {
    const secret = `private-upstream-${testCase.status}`;
    let upstreamCalls = 0;
    const client = await createAnthropicClient(async () => {
      upstreamCalls += 1;
      return Response.json({ error: { message: secret } }, { status: testCase.status });
    });

    let thrown: unknown;
    try {
      await client.messages.create({
        model: "vendor/model-1",
        max_tokens: 16,
        messages: [{ role: "user", content: "Trigger an error." }],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(testCase.errorClass);
    expect(thrown).toMatchObject({ status: testCase.status, type: testCase.type });
    expect(String(thrown)).not.toContain(secret);
    expect(upstreamCalls).toBe(1);
  });
});
