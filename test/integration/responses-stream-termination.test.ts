import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { parseSseStream } from "../../src/stream/sse-parser.js";
import { chatStream, responsesFrames } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Status = "completed" | "incomplete";
const apps: ReturnType<typeof buildApp>[] = [];
const modes = [
  { protocol: "chat", upstreamDone: true },
  { protocol: "responses", upstreamDone: true },
  { protocol: "responses", upstreamDone: false },
] as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(mode: (typeof modes)[number], status: Status) {
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: mode.protocol,
    }),
    logger: false,
    upstreamFetch: async () => {
      if (mode.protocol === "chat") {
        return chatStream({
          id: "chat_termination",
          model: "m",
          created: 123,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "正文正常" },
              finish_reason: status === "completed" ? "stop" : "length",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        });
      }
      const frames = responsesFrames({
        id: "resp_termination",
        model: "m",
        status,
        incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
        output: [
          {
            id: "msg_termination",
            type: "message",
            role: "assistant",
            status,
            content: [{ type: "output_text", text: "正文正常", annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      return new Response((mode.upstreamDone ? frames : frames.slice(0, -1)).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  apps.push(app);
  return app;
}

describe.each(
  modes,
)("Responses SSE termination (upstream=$protocol, DONE=$upstreamDone)", (mode) => {
  it.each([
    "completed",
    "incomplete",
  ] as const)("ends with response.%s and every data event is JSON", async (status) => {
    const app = setup(mode, status);
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: "m", input: "hello", stream: true },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.body).toContain('"delta":"正文正常"');

    const events: Wire[] = [];
    const body = new Response(result.body).body;
    if (!body) throw new Error("Expected an SSE body");
    // Consume through EOF like a JSON-only Responses client, without filtering sentinels.
    for await (const frame of parseSseStream(body)) {
      const event = JSON.parse(frame.data) as Wire;
      expect(event.type).toBe(frame.event);
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: `response.${status}`,
      response: {
        status,
        output: [{ content: [{ type: "output_text", text: "正文正常" }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    });
    expect(events.filter((event) => event.type === `response.${status}`)).toHaveLength(1);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  it("lets the OpenAI SDK aggregate a final response at EOF", async () => {
    const app = setup(mode, "completed");
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new OpenAI({ baseURL: `${address}/v1`, apiKey: "caller-key", maxRetries: 0 });
    const stream = client.responses.stream({ model: "m", input: "hello" });
    const response = await stream.finalResponse();
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("正文正常");
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
  });
});

// 模拟 DeepSeek 类 Chat 上游：推理、正文、finish_reason 帧之后再补发 usage 帧并以 [DONE] 结束，
// 同时覆盖聚合网关常见的收尾变体。上游已正常结束时，Responses 只能以 response.completed 收尾。
const chatBase = {
  id: "chatcmpl_tail",
  object: "chat.completion.chunk",
  created: 100,
  model: "deepseek-v4.1-flash",
};
const chatUsage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  completion_tokens_details: { reasoning_tokens: 2 },
};
const sse = (payload: Wire) => `data: ${JSON.stringify(payload)}\n\n`;
const chatChunk = (choices: unknown, fields: Wire = {}) => sse({ ...chatBase, choices, ...fields });
const chatDone = "data: [DONE]\n\n";
const chatHead = [
  chatChunk([
    {
      index: 0,
      delta: { role: "assistant", content: null, reasoning_content: "" },
      finish_reason: null,
    },
  ]),
  chatChunk([{ index: 0, delta: { reasoning_content: "先想" }, finish_reason: null }]),
  chatChunk([{ index: 0, delta: { content: "你好" }, finish_reason: null }]),
  chatChunk([{ index: 0, delta: { content: "" }, finish_reason: "stop" }]),
];
const chatTails: Array<[string, string[]]> = [
  ["空 choices 的 usage 帧与 [DONE]", [chatChunk([], { usage: chatUsage }), chatDone]],
  ["缺少 [DONE]", [chatChunk([], { usage: chatUsage })]],
  ["[DONE] 后缺少空行", [chatChunk([], { usage: chatUsage }), "data: [DONE]"]],
  [
    "usage 帧改写 id、model 与 created",
    [
      sse({
        ...chatBase,
        id: "chatcmpl_usage",
        model: "deepseek-chat",
        created: 109,
        choices: [],
        usage: chatUsage,
      }),
      chatDone,
    ],
  ],
  [
    "usage 帧携带空 delta",
    [
      chatChunk([{ index: 0, delta: { content: "" }, finish_reason: null }], { usage: chatUsage }),
      chatDone,
    ],
  ],
  [
    "usage 帧重复 finish_reason",
    [chatChunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage: chatUsage }), chatDone],
  ],
  ["usage 帧省略 choices", [sse({ ...chatBase, usage: chatUsage }), chatDone]],
];

function setupChatUpstream(frames: string[]) {
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: "chat",
    }),
    logger: false,
    upstreamFetch: async () =>
      new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }),
  });
  apps.push(app);
  return app;
}

async function responsesEvents(app: ReturnType<typeof buildApp>): Promise<Wire[]> {
  const result = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: { authorization: "Bearer caller-key" },
    payload: {
      model: "deepseek-v4.1-flash",
      stream: true,
      store: false,
      max_output_tokens: 32768,
      prompt_cache_key: "session-1",
      input: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "hi" },
        { role: "user", content: "继续" },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    },
  });
  expect(result.statusCode, result.body).toBe(200);
  const body = new Response(result.body).body;
  if (!body) throw new Error("Expected an SSE body");
  const events: Wire[] = [];
  for await (const frame of parseSseStream(body)) events.push(JSON.parse(frame.data) as Wire);
  return events;
}

describe("Chat 上游收尾帧转换为 Responses 终态", () => {
  it.each(chatTails)("%s 时以 response.completed 结束并保留 usage", async (_name, tail) => {
    const events = await responsesEvents(setupChatUpstream([...chatHead, ...tail]));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "先想" }] },
          { type: "message", content: [{ type: "output_text", text: "你好" }] },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    });
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  it("OpenAI SDK 在上游缺少 [DONE] 时仍聚合出完成的响应", async () => {
    const app = setupChatUpstream([...chatHead, chatChunk([], { usage: chatUsage })]);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new OpenAI({ baseURL: `${address}/v1`, apiKey: "caller-key", maxRetries: 0 });
    const response = await client.responses
      .stream({ model: "deepseek-v4.1-flash", input: "hi" })
      .finalResponse();

    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("你好");
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it.each([
    ["finish_reason 之前断流", chatHead.slice(0, 3)],
    [
      "finish_reason 之后继续输出正文",
      [...chatHead, chatChunk([{ index: 0, delta: { content: "多余" } }]), chatDone],
    ],
    [
      "上游发送错误帧",
      [...chatHead.slice(0, 3), sse({ error: { message: "overloaded", code: "busy" } })],
    ],
  ])("%s 时仍以 error 结束", async (_name, frames) => {
    const events = await responsesEvents(setupChatUpstream(frames));

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some((event) => event.type === "response.completed")).toBe(false);
  });

  it("Chat 与 Anthropic 入口在同样的收尾帧下也正常完成", async () => {
    const tail = [
      sse({ ...chatBase, id: "chatcmpl_usage", created: 109, choices: [], usage: chatUsage }),
    ];
    const app = setupChatUpstream([...chatHead, ...tail]);
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer caller-key" },
      payload: {
        model: "deepseek-v4.1-flash",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(chat.body).not.toContain("upstream_stream_error");
    expect(chat.body).toContain('"prompt_tokens":10');
    expect(chat.body.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const anthropic = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-api-key": "caller-key", "anthropic-version": "2023-06-01" },
      payload: {
        model: "deepseek-v4.1-flash",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(anthropic.body).not.toContain("event: error");
    expect(anthropic.body).toContain('"stop_reason":"end_turn"');
    expect(anthropic.body.trimEnd().endsWith('{"type":"message_stop"}')).toBe(true);
  });
});
