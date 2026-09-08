import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { responsesStream } from "../helpers/upstream.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const responseBody = {
  id: "resp_cache",
  model: "m",
  status: "completed",
  output: [],
  usage: { input_tokens: 12, output_tokens: 1, input_tokens_details: { cached_tokens: 8 } },
};

describe("默认缓存请求链路", () => {
  it.each([
    "/v1/messages",
    "/v1/responses",
  ])("%s 的自动键跨轮次、JSON/SSE 稳定，且不受 Claude Code 断点开关影响", async (url) => {
    const bodies: Array<Record<string, unknown>> = [];
    const app = buildApp({
      config: loadConfig({
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        PROMPT_CACHE_BREAKPOINTS_ENABLED: "false",
      }),
      logger: false,
      upstreamFetch: async (input, init) => {
        const body = (await new Request(input, init).json()) as Record<string, unknown>;
        bodies.push(body);
        return body.stream ? responsesStream(responseBody) : Response.json(responseBody);
      },
    });
    apps.push(app);
    for (const stream of [false, true]) {
      const messages = [
        { role: "user", content: "问题" },
        ...(stream
          ? [
              { role: "assistant", content: "回答" },
              { role: "user", content: "下一轮" },
            ]
          : []),
      ];
      const result = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: "Bearer key",
          "user-agent": "claude-cli/2.1.220 (external, cli)",
        },
        payload:
          url === "/v1/messages"
            ? { model: "m", max_tokens: 32, system: "固定提示", messages, stream }
            : { model: "m", instructions: "固定提示", input: messages, stream },
      });
      expect(result.statusCode, result.body).toBe(200);
    }
    expect(bodies[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
  });

  it.each([
    false,
    true,
  ])("Responses 显式 null 在 JSON/SSE 中都抑制自动键，stream=%s", async (stream) => {
    let sent: Record<string, unknown> | undefined;
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      upstreamFetch: async (input, init) => {
        sent = (await new Request(input, init).json()) as Record<string, unknown>;
        return stream ? responsesStream(responseBody) : Response.json(responseBody);
      },
    });
    apps.push(app);
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer key" },
      payload: {
        model: "m",
        instructions: "固定提示",
        input: "问题",
        prompt_cache_key: null,
        stream,
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(sent).toHaveProperty("prompt_cache_key", null);
  });

  it.each([false, true])("网关搜索续轮沿用初始缓存键，stream=%s", async (stream) => {
    const bodies: Array<Record<string, unknown>> = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      webSearchProvider: {
        capabilities() {
          return { execute: true, citations: true, streaming: true };
        },
        async execute() {
          return [{ title: "资料", url: "https://example.test", content: "资料正文" }];
        },
      },
      upstreamFetch: async (input, init) => {
        bodies.push((await new Request(input, init).json()) as Record<string, unknown>);
        const body =
          bodies.length === 1
            ? {
                ...responseBody,
                output: [
                  {
                    type: "function_call",
                    id: "fc_search",
                    call_id: "call_search",
                    name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                    arguments: '{"query":"资料"}',
                  },
                ],
              }
            : responseBody;
        return stream ? responsesStream(body) : Response.json(body);
      },
    });
    apps.push(app);
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer key" },
      payload: {
        model: "m",
        instructions: "固定提示",
        input: "问题",
        tools: [{ type: "web_search" }],
        stream,
      },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
  });

  it.each([
    { stream: false, fallback: false },
    { stream: true, fallback: false },
    { stream: false, fallback: true },
    { stream: true, fallback: true },
  ])("Messages 显式键及 null 在普通、流式和回退请求中保持：%j", async ({ stream, fallback }) => {
    const bodies: Array<Record<string, unknown>> = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      upstreamFetch: async (input, init) => {
        const req = new Request(input, init);
        bodies.push((await req.json()) as Record<string, unknown>);
        if (req.url.endsWith("responses")) {
          if (fallback)
            return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
          return stream ? responsesStream(responseBody) : Response.json(responseBody);
        }
        const chat = {
          id: "chat_cache",
          model: "m",
          choices: [{ message: { role: "assistant", content: "回答" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        };
        return stream
          ? new Response(
              `data: ${JSON.stringify({ ...chat, choices: [{ index: 0, delta: { content: "回答" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(chat);
      },
    });
    apps.push(app);
    for (const key of ["explicit-key", null]) {
      bodies.length = 0;
      const result = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-api-key": "key" },
        payload: {
          model: "m",
          system: "固定提示",
          max_tokens: 32,
          messages: [{ role: "user", content: "问题" }],
          prompt_cache_key: key,
          stream,
        },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(bodies).toHaveLength(fallback ? 2 : 1);
      expect(bodies.every((body) => body.prompt_cache_key === key)).toBe(true);
    }
  });
});
