import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { RequestDrain } from "../../src/http/request-drain.js";
import { chatStream } from "../helpers/upstream.js";

const apps: ReturnType<typeof buildApp>[] = [];
const sockets: WebSocket[] = [];
const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
const completion = {
  id: "chat_drain",
  model: "m",
  created: 1,
  choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "finished safely" } },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(upstreamFetch: typeof fetch) {
  const drain = new RequestDrain();
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      SSE_HEARTBEAT_INTERVAL_MS: "20",
    }),
    logger: false,
    drain,
    upstreamFetch,
  });
  apps.push(app);
  return { app, drain };
}

describe("request drain for safe Docker updates", () => {
  it.each(
    ["/v1/messages", "/v1/responses", "/v1/chat/completions"].flatMap((url) =>
      [false, true].map((stream) => ({ url, stream })),
    ),
  )("lets accepted $url (stream=$stream) finish while rejecting new requests", async ({
    url,
    stream,
  }) => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<AbortSignal>();
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      started.resolve(init?.signal as AbortSignal);
      await gate.promise;
      return stream ? chatStream(completion) : Response.json(completion);
    });
    const { app, drain } = setup(upstream);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const payload = {
      model: "m",
      stream,
      max_tokens: 32,
      ...(url === "/v1/responses"
        ? { input: "hello" }
        : { messages: [{ role: "user", content: "hello" }] }),
    };
    const response = fetch(address + url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const signal = await started.promise;
    expect(drain.status().activeRequests).toBe(1);
    drain.begin();
    try {
      const refused = await app.inject({
        method: "POST",
        url,
        headers: { ...headers, origin: "https://client.test" },
        payload,
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.headers["retry-after"]).toBe("5");
      expect(refused.headers["access-control-allow-origin"]).toBe("*");
      expect(upstream).toHaveBeenCalledTimes(1);
      expect((await app.inject("/health/ready")).statusCode).toBe(503);
      expect((await app.inject("/health/live")).statusCode).toBe(200);
      expect(drain.status()).toEqual({ draining: true, activeRequests: 1 });
      expect(signal.aborted).toBe(false);
    } finally {
      gate.resolve();
    }
    const completed = await response;
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("finished safely");
    await vi.waitFor(() => expect(drain.status()).toEqual({ draining: true, activeRequests: 0 }));
    drain.resume();
    expect((await app.inject("/health/ready")).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
    expect(drain.status().activeRequests).toBe(0);
  });

  it("releases a disconnected SSE request and its upstream while draining", async () => {
    let signal: AbortSignal | undefined;
    const { app, drain } = setup(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "m", input: "hello", stream: true }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(drain.status().activeRequests).toBe(1);
    drain.begin();
    controller.abort();
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
      expect(drain.status()).toEqual({ draining: true, activeRequests: 0 });
    });
  });

  it("counts queued WS generations, allows them to finish, and ignores idle connections", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let calls = 0;
    const { app, drain } = setup(async () => {
      const gate = gates[calls++];
      if (gate) await gate.promise;
      return chatStream({ ...completion, id: `chat_${calls}` });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http:", "ws:")}/v1/responses`, { headers });
    sockets.push(socket);
    const events: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => events.push(JSON.parse(String(data))));
    await once(socket, "open");
    expect(drain.status().activeRequests).toBe(0);
    const send = () =>
      socket.send(JSON.stringify({ type: "response.create", model: "m", input: "hello" }));
    send();
    send();
    await vi.waitFor(() => expect(drain.status().activeRequests).toBe(2));
    expect(calls).toBe(1);
    drain.begin();
    try {
      send();
      await vi.waitFor(() =>
        expect(events.find((event) => event.type === "error")).toMatchObject({
          status: 503,
          error: { code: "server_draining" },
        }),
      );
      expect(drain.status().activeRequests).toBe(2);
      gates[0]?.resolve();
      await vi.waitFor(() => expect(calls).toBe(2));
      expect(drain.status().activeRequests).toBe(1);
      gates[1]?.resolve();
      await vi.waitFor(() => expect(drain.status().activeRequests).toBe(0));
      expect(events.filter((event) => event.type === "response.completed")).toHaveLength(2);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      const upgrade = await app.inject({ method: "GET", url: "/v1/responses", headers });
      expect(upgrade.statusCode).toBe(503);
      drain.resume();
      send();
      await vi.waitFor(() =>
        expect(events.filter((event) => event.type === "response.completed")).toHaveLength(3),
      );
    } finally {
      for (const gate of gates) gate.resolve();
    }
  });

  it("releases invalid/unauthorized requests and exposes no HTTP drain control", async () => {
    const { app, drain } = setup(async () => Response.json(completion));
    expect(
      (await app.inject({ method: "POST", url: "/v1/responses", payload: {} })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(drain.status().activeRequests).toBe(0);
    for (const url of ["/drain", "/resume", "/status"]) {
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(404);
    }
    expect(drain.status()).toEqual({ draining: false, activeRequests: 0 });
  });

  it("does not trust an Upgrade header on an ordinary POST to bypass draining", async () => {
    const gate = Promise.withResolvers<void>();
    const { app, drain } = setup(async () => {
      await gate.promise;
      return Response.json(completion);
    });
    const pending = app
      .inject({
        method: "POST",
        url: "/v1/responses",
        headers: { ...headers, upgrade: "websocket" },
        payload: { model: "m", input: "hello" },
      })
      .then((response) => response);
    try {
      await vi.waitFor(() => expect(drain.status().activeRequests).toBe(1));
      drain.begin();
      expect(drain.status()).toEqual({ draining: true, activeRequests: 1 });
    } finally {
      gate.resolve();
    }
    expect((await pending).statusCode).toBe(200);
    expect(drain.status().activeRequests).toBe(0);
  });
});
