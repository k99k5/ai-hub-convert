import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { responsesFrames } from "../helpers/upstream.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const cancel = vi.fn(() => {
    open = false;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(source) {
        controller = source;
      },
      cancel,
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  return {
    response,
    cancel,
    send(wire: string) {
      if (open) controller.enqueue(new TextEncoder().encode(wire));
    },
    close() {
      if (open) {
        open = false;
        controller.close();
      }
    },
  };
}

function chatFrame(delta: Record<string, unknown>, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: "chat_heartbeat", model: "m", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function config(protocol: "chat" | "responses" = "chat") {
  return loadConfig({
    UPSTREAM_BASE_URL: "https://upstream.test/v1",
    UPSTREAM_PROTOCOL: protocol,
    SSE_HEARTBEAT_INTERVAL_MS: "20",
    UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "2000",
    UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "2000",
    UPSTREAM_TIMEOUT_MS: "5000",
  });
}

const streamCases = [
  { url: "/v1/responses", protocol: "chat" as const },
  { url: "/v1/responses", protocol: "responses" as const },
  { url: "/v1/chat/completions", protocol: "chat" as const },
  { url: "/v1/messages", protocol: "chat" as const },
  { url: "/v1/messages", protocol: "responses" as const },
];
const urls = ["/v1/responses", "/v1/chat/completions", "/v1/messages"];
const headers = { authorization: "Bearer caller-key", "content-type": "application/json" };

function payload(url: string, stream: boolean | undefined) {
  return {
    model: "m",
    ...(stream === undefined ? {} : { stream }),
    ...(url === "/v1/responses"
      ? { input: "hello" }
      : { messages: [{ role: "user", content: "hello" }] }),
    ...(url === "/v1/messages" ? { max_tokens: 64 } : {}),
  };
}

function completedFrames(protocol: "chat" | "responses") {
  return protocol === "chat"
    ? [chatFrame({ content: "answer" }), chatFrame({}, "stop"), "data: [DONE]\n\n"]
    : responsesFrames({
        id: "resp_heartbeat",
        model: "m",
        status: "completed",
        output: [
          {
            id: "msg_answer",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
}

async function readWire(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  until: (wire: string) => boolean = () => false,
) {
  const decoder = new TextDecoder();
  let wire = "";
  while (!until(wire)) {
    const part = await reader.read();
    if (part.done) return wire + decoder.decode();
    wire += decoder.decode(part.value, { stream: true });
  }
  return wire;
}

describe("SSE downstream heartbeats", () => {
  it.each(
    streamCases.flatMap((route) => ["headers", "body"].map((wait) => ({ ...route, wait }))),
  )("sends comments before upstream $wait arrive for $url in $protocol mode", async ({
    url,
    protocol,
    wait,
  }) => {
    const source = controlledStream();
    const ready = Promise.withResolvers<Response>();
    const app = buildApp({
      config: config(protocol),
      logger: false,
      upstreamFetch: async () => (wait === "headers" ? ready.promise : source.response),
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(`${address}${url}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload(url, true)),
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      let wire = await readWire(reader, (text) => (text.match(/: ping\n\n/g) ?? []).length >= 2);
      expect(wire).toMatch(/^(?:: ping\n\n){2,}$/);
      ready.resolve(source.response);
      source.send(completedFrames(protocol).join(""));
      source.close();
      wire += await readWire(reader);
      expect(wire).toContain("answer");
      expect(wire).not.toContain("event: error");
      expect(wire).not.toContain("data: : ping");
      expect(wire).not.toContain('data: {"type":"ping"}');
      expect(wire).toContain(url === "/v1/messages" ? "event: message_stop" : "data: [DONE]");
    } finally {
      clearTimeout(deadline);
      ready.resolve(source.response);
      source.close();
      abort.abort();
    }
  });

  it.each(
    urls,
  )("returns a stream error if upstream HTTP fails after the first heartbeat on %s", async (url) => {
    const ready = Promise.withResolvers<Response>();
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async () => ready.promise,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(`${address}${url}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload(url, true)),
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      const prefix = await readWire(reader, (wire) => wire.includes(": ping\n\n"));
      expect(prefix).toMatch(/^(?:: ping\n\n)+$/);
      ready.resolve(
        Response.json({ error: { message: "private-upstream-error" } }, { status: 429 }),
      );
      const wire = await readWire(reader);
      expect(wire).toContain('"error"');
      expect(wire).not.toContain("private-upstream-error");
      expect(wire).not.toContain("[DONE]");
      expect(wire).not.toContain("event: message_stop");
    } finally {
      clearTimeout(deadline);
      ready.resolve(new Response(null, { status: 500 }));
      abort.abort();
    }
  });

  it.each(
    urls.flatMap((url) => ["headers", "body"].map((wait) => ({ url, wait }))),
  )("cancels upstream $wait on client disconnect before the first data frame on $url", async ({
    url,
    wait,
  }) => {
    const source = controlledStream();
    let upstreamAborted = false;
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async (_url, init) => {
        const ready = Promise.withResolvers<Response>();
        init?.signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            ready.reject(init.signal?.reason);
          },
          { once: true },
        );
        if (wait === "body") ready.resolve(source.response);
        return ready.promise;
      },
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(`${address}${url}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload(url, true)),
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      expect(await readWire(reader, (wire) => wire.includes(": ping\n\n"))).toMatch(
        /^(?:: ping\n\n)+$/,
      );
      await reader.cancel();
      await vi.waitFor(() => expect(upstreamAborted).toBe(true));
      if (wait === "body") await vi.waitFor(() => expect(source.cancel).toHaveBeenCalledOnce());
    } finally {
      clearTimeout(deadline);
      abort.abort();
      source.close();
    }
  });

  it.each(urls)("does not extend the upstream first-byte timeout on %s", async (url) => {
    const source = controlledStream();
    const settings = config();
    settings.upstream.firstByteTimeoutMs = 100;
    const app = buildApp({
      config: settings,
      logger: false,
      upstreamFetch: async () => source.response,
    });
    apps.push(app);
    try {
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload: payload(url, true),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(": ping\n\n");
      expect(response.body).toContain('"error"');
      expect(response.body).not.toContain("[DONE]");
      expect(source.cancel).toHaveBeenCalledOnce();
    } finally {
      source.close();
    }
  });

  it.each(
    urls.flatMap((url) => [false, undefined].map((stream) => ({ url, stream }))),
  )("keeps slow JSON success and error responses unchanged on $url with stream=$stream", async ({
    url,
    stream,
  }) => {
    let denied = true;
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return denied
          ? Response.json({ error: { message: "private-upstream-error" } }, { status: 429 })
          : Response.json({
              id: "chat_json",
              model: "m",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "answer" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            });
      },
    });
    apps.push(app);
    for (const shouldFail of [true, false]) {
      denied = shouldFail;
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload: payload(url, stream),
      });
      expect(response.statusCode).toBe(denied ? 429 : 200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.headers["x-accel-buffering"]).toBeUndefined();
      expect(response.body).not.toContain(": ping");
      expect(response.body).not.toContain("event: ping");
      expect(response.body).not.toContain("private-upstream-error");
      if (!denied) expect(response.body).toContain("answer");
    }
  });

  it("preserves Anthropic protocol pings alongside independent comment heartbeats", async () => {
    const source = controlledStream();
    const settings = config();
    settings.server.anthropicPingIntervalMs = 5;
    const app = buildApp({
      config: settings,
      logger: false,
      upstreamFetch: async () => source.response,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 1500);
    source.send(chatFrame({ content: "answer" }));
    try {
      const response = await fetch(`${address}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload("/v1/messages", true)),
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      let wire = await readWire(
        reader,
        (text) =>
          text.includes('event: ping\ndata: {"type":"ping"}') &&
          (text.match(/: ping\n\n/g) ?? []).length >= 2,
      );
      expect(wire).toContain('event: ping\ndata: {"type":"ping"}');
      expect(wire.match(/: ping\n\n/g)?.length).toBeGreaterThanOrEqual(2);
      source.send(`${chatFrame({}, "stop")}data: [DONE]\n\n`);
      source.close();
      wire += await readWire(reader);
      expect(wire).toContain("event: message_stop");
      expect(wire).not.toContain("event: error");
    } finally {
      clearTimeout(deadline);
      abort.abort();
      source.close();
    }
  });

  it.each([
    { url: "/v1/responses", protocol: "chat" as const },
    { url: "/v1/responses", protocol: "responses" as const },
    { url: "/v1/chat/completions", protocol: "chat" as const },
  ])("keeps $url alive during upstream-only heartbeats in $protocol mode", async ({
    url,
    protocol,
  }) => {
    const source = controlledStream();
    const upstream = vi.fn(async () => source.response);
    const app = buildApp({ config: config(protocol), logger: false, upstreamFetch: upstream });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const frames =
      protocol === "chat"
        ? [chatFrame({ content: "answer" }), chatFrame({}, "stop"), "data: [DONE]\n\n"]
        : responsesFrames({
            id: "resp_heartbeat",
            model: "m",
            status: "completed",
            output: [
              {
                id: "msg_answer",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "answer", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          });
    source.send(frames[0] ?? "");
    const pulse = setInterval(() => source.send(": upstream heartbeat\n\n"), 10);
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new Error("No downstream heartbeat received")),
      1500,
    );
    try {
      const response = await fetch(`${address}${url}`, {
        method: "POST",
        headers: { authorization: "Bearer caller-key", "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          ...(url === "/v1/responses"
            ? { input: "hello" }
            : { messages: [{ role: "user", content: "hello" }] }),
        }),
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      let wire = "";
      const decoder = new TextDecoder();
      while ((wire.match(/: ping\n\n/g) ?? []).length < 2) {
        const part = await reader.read();
        if (part.done) throw new Error(`Stream ended before heartbeat: ${wire}`);
        wire += decoder.decode(part.value, { stream: true });
      }
      source.send(frames.slice(1).join(""));
      source.close();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        wire += decoder.decode(part.value, { stream: true });
      }
      expect(wire).not.toContain("event: error");
      expect(wire).not.toContain('"error":{');
      expect(wire).toContain("data: [DONE]");
      if (url === "/v1/responses") expect(wire).toContain("event: response.completed");
      expect(upstream).toHaveBeenCalledOnce();
    } finally {
      clearTimeout(deadline);
      clearInterval(pulse);
      abort.abort();
      source.close();
    }
  });

  it("lets the OpenAI SDK aggregate Responses while ignoring heartbeat comments", async () => {
    const source = controlledStream();
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async () => source.response,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    source.send(chatFrame({ content: "first" }));
    let heartbeats = 0;
    const client = new OpenAI({
      apiKey: "caller-key",
      baseURL: `${address}/v1`,
      maxRetries: 0,
      timeout: 1500,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const decoder = new TextDecoder();
        let wire = "";
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              wire += decoder.decode(chunk, { stream: true });
              if (heartbeats === 0 && wire.includes(": ping\n\n")) {
                heartbeats++;
                source.send(`${chatFrame({ content: " second" }, "stop")}data: [DONE]\n\n`);
                source.close();
              }
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, { status: response.status, headers: response.headers });
      },
    });
    try {
      const result = await client.responses.stream({ model: "m", input: "hello" }).finalResponse();
      expect(result.output_text).toBe("first second");
      expect(result.status).toBe("completed");
      expect(heartbeats).toBeGreaterThan(0);
    } finally {
      source.close();
    }
  });

  it.each([
    "/v1/responses",
    "/v1/chat/completions",
  ])("preserves HTTP errors and JSON responses before %s starts streaming", async (url) => {
    let denied = true;
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async () => {
        if (!denied) await new Promise((resolve) => setTimeout(resolve, 70));
        return denied
          ? Response.json({ error: { message: "private-upstream-error" } }, { status: 429 })
          : Response.json({
              id: "chat_json",
              model: "m",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "answer" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            });
      },
    });
    apps.push(app);
    for (const stream of [true, false]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: "Bearer caller-key" },
        payload: {
          model: "m",
          stream,
          ...(url === "/v1/responses"
            ? { input: "hello" }
            : { messages: [{ role: "user", content: "hello" }] }),
        },
      });
      expect(response.statusCode).toBe(denied ? 429 : 200);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).not.toContain(": ping\n\n");
      expect(response.body).not.toContain("private-upstream-error");
      if (denied) expect(response.json().error.type).toBe("rate_limit_error");
      else expect(response.body).toContain("answer");
      denied = false;
    }
  });

  it("cancels upstream consumption when a client disconnects after a heartbeat", async () => {
    const source = controlledStream();
    const app = buildApp({
      config: config(),
      logger: false,
      upstreamFetch: async () => source.response,
    });
    apps.push(app);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    source.send(chatFrame({ content: "answer" }));
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(`${address}/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer caller-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, input: "hello" }),
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected a stream");
      let wire = "";
      const decoder = new TextDecoder();
      while (!wire.includes(": ping\n\n")) {
        const part = await reader.read();
        if (part.done) throw new Error("Stream ended before heartbeat");
        wire += decoder.decode(part.value, { stream: true });
      }
      await reader.cancel();
      await vi.waitFor(() => expect(source.cancel).toHaveBeenCalledOnce());
    } finally {
      clearTimeout(deadline);
      abort.abort();
      source.close();
    }
  });
});
