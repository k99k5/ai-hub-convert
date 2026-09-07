import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME as name } from "../../src/providers/web-search/internal.js";
import { responsesStream } from "../helpers/upstream.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const headers = { "content-type": "application/json", authorization: "Bearer test-key" };
const searchTool = { type: "web_search_20250305", name: "web_search" };
const request = { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
const output = [
  {
    id: "msg",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "answer", annotations: [] }],
  },
];
const answer = {
  id: "resp_answer",
  object: "response",
  created_at: 1,
  model: "m",
  status: "completed",
  output,
  usage: { input_tokens: 20, output_tokens: 2 },
};
const search = {
  ...answer,
  id: "resp_search",
  output: [
    {
      id: "fc",
      type: "function_call",
      call_id: "call",
      name,
      arguments: '{"query":"docs"}',
      status: "completed",
    },
  ],
};

it("keeps default HTTP sockets open while waiting for a normal non-stream completion", async () => {
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async () => {
      await delay(50);
      return Response.json(answer);
    },
  });
  apps.push(app);
  expect(app.server.timeout).toBe(0);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "m", input: "hello" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ output });
});

it("accepts its own Responses output as the next request's history", async () => {
  let calls = 0;
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async () => {
      calls++;
      return Response.json(answer);
    },
  });
  apps.push(app);
  const first = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers,
    payload: { model: "m", input: "hello" },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/responses",
    headers,
    payload: { model: "m", input: [...first.json().output, { role: "user", content: "continue" }] },
  });
  expect(second.statusCode).toBe(200);
  expect(calls).toBe(2);
});

it.each([
  false,
  true,
])("does not restart through Chat after executing a search (stream=%s)", async (stream) => {
  const paths: string[] = [];
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async (url) => {
      paths.push(new URL(url as URL).pathname);
      if (paths.length === 1) return stream ? responsesStream(search) : Response.json(search);
      return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    },
  });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers,
    payload: { ...request, stream, tools: [searchTool] },
  });
  expect(paths).toEqual(["/v1/responses", "/v1/responses"]);
  if (stream) {
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("event: message_stop");
  } else expect(response.statusCode).toBe(404);
});

it("shares one request deadline across the Responses-to-Chat fallback", async () => {
  const paths: string[] = [];
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_TIMEOUT_MS: "200",
    }),
    logger: false,
    upstreamFetch: async (url, init) => {
      paths.push(new URL(url as URL).pathname);
      if (paths.length === 1) {
        await delay(140, undefined, { signal: init?.signal as AbortSignal });
        return new Response(null, { status: 405 });
      }
      await delay(140, undefined, { signal: init?.signal as AbortSignal });
      return Response.json({
        id: "chat",
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content: "too late" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers,
    payload: request,
  });
  expect(paths).toEqual(["/v1/responses", "/v1/chat/completions"]);
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("too late");
});

it("sends message_start and pings while search is blocked, then resumes with correctly indexed blocks", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let round = 0;
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      ANTHROPIC_PING_INTERVAL_MS: "20",
    }),
    logger: false,
    upstreamFetch: async () =>
      responsesStream(
        ++round === 1 ? { ...search, output: [...output, ...search.output] } : answer,
      ),
    webSearchProvider: {
      capabilities: () => ({ execute: true, streaming: false, citations: false }),
      execute: async () => {
        started.resolve();
        await release.promise;
        return [{ title: "docs", url: "https://example.com", content: "docs" }];
      },
    },
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request, stream: true, tools: [searchTool] }),
  });
  await started.promise;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No client stream");
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (!text.includes("event: ping")) {
      const part = await reader.read();
      if (part.done) throw new Error("Stream ended before search completed");
      text += decoder.decode(part.value);
    }
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"answer"');
    expect(round).toBe(1);
  } finally {
    release.resolve();
  }
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value);
  }
  expect(text).toContain("event: message_stop");
  expect(text).not.toContain(name);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  expect(
    data.filter((event) => event.type === "content_block_start").map((event) => event.index),
  ).toEqual([0, 1, 2, 3]);
  expect(
    data.filter((event) => event.type === "content_block_stop").map((event) => event.index),
  ).toEqual([0, 1, 2, 3]);
  expect(data.find((event) => event.type === "message_delta").usage).toMatchObject({
    input_tokens: 40,
    output_tokens: 4,
    server_tool_use: { web_search_requests: 1 },
  });
});

it("cancels a pending search when the client disconnects", async () => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async () => responsesStream(search),
    webSearchProvider: {
      capabilities: () => ({ execute: true, streaming: false, citations: false }),
      execute: async (_request, context) => {
        started.resolve();
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => {
              aborted.resolve();
              reject(context.signal.reason);
            },
            { once: true },
          ),
        );
      },
    },
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/v1/messages`, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({ ...request, stream: true, tools: [searchTool] }),
  });
  await started.promise;
  controller.abort();
  await response.body?.cancel().catch(() => undefined);
  await aborted.promise;
});
