import { request as httpRequest, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { ActiveStreamRegistry } from "../../src/stream/active-streams.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

function createApp(
  environment: Record<string, string> = {},
  upstreamFetch?: typeof globalThis.fetch,
) {
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://gateway.example.test/v1",
      ...environment,
    }),
    logger: false,
    ...(upstreamFetch === undefined ? {} : { upstreamFetch }),
  });
  apps.push(app);
  return app;
}

function observeNextActiveStreamRemoval(): { removed: Promise<void>; restore: () => void } {
  const removal = Promise.withResolvers<void>();
  const originalAdd = ActiveStreamRegistry.prototype.add;
  const add = vi.spyOn(ActiveStreamRegistry.prototype, "add").mockImplementation(function (
    this: ActiveStreamRegistry,
    ...arguments_: Parameters<typeof originalAdd>
  ) {
    const remove = Reflect.apply(originalAdd, this, arguments_);
    return () => {
      remove();
      removal.resolve();
    };
  });
  return { removed: removal.promise, restore: () => add.mockRestore() };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health routes", () => {
  it("reports liveness and readiness without calling the upstream", async () => {
    const app = createApp();

    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: "ready" });
  });
});

describe("request validation", () => {
  it.each([
    {
      url: "/v1/messages",
      payload: { max_tokens: 64, messages: [] },
      outputConfig: { effort: "minimal" },
    },
    {
      url: "/v1/messages/count_tokens",
      payload: { messages: [] },
      outputConfig: { effort: "minimal" },
    },
    {
      url: "/v1/messages",
      payload: { max_tokens: 64, messages: [] },
      outputConfig: { format: { type: "json_schema" } },
    },
    {
      url: "/v1/messages/count_tokens",
      payload: { messages: [] },
      outputConfig: { format: { type: "json_schema" } },
    },
    {
      url: "/v1/messages",
      payload: { max_tokens: 64, messages: [] },
      outputConfig: { unknown_control: true },
    },
    {
      url: "/v1/messages/count_tokens",
      payload: { messages: [] },
      outputConfig: { unknown_control: true },
    },
  ])("rejects unsupported Anthropic output_config before upstream access at $url", async (testCase) => {
    let upstreamCalls = 0;
    const app = createApp({}, async () => {
      upstreamCalls += 1;
      throw new Error("Unexpected upstream call");
    });

    const response = await app.inject({
      method: "POST",
      url: testCase.url,
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        output_config: testCase.outputConfig,
        ...testCase.payload,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(upstreamCalls).toBe(0);
  });

  it.each([
    {
      url: "/v1/messages",
      headers: { "x-api-key": "caller-key" },
      payload: { model: "vendor/model-1", messages: [] },
      error: { type: "error", error: { type: "invalid_request_error" } },
    },
    {
      url: "/v1/messages/count_tokens",
      headers: { "x-api-key": "caller-key" },
      payload: { model: "vendor/model-1" },
      error: { type: "error", error: { type: "invalid_request_error" } },
    },
    {
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: 42 },
      error: {
        error: { type: "invalid_request_error", code: "invalid_request" },
      },
    },
  ])("returns a protocol-native 400 for $url before upstream access", async (testCase) => {
    let upstreamCalls = 0;
    const app = createApp({}, async () => {
      upstreamCalls++;
      throw new Error("Unexpected upstream call");
    });

    const response = await app.inject({
      method: "POST",
      url: testCase.url,
      headers: { "content-type": "application/json", ...testCase.headers },
      payload: testCase.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(testCase.error);
    expect(response.body).not.toContain("body/");
    expect(upstreamCalls).toBe(0);
  });

  it.each([
    {
      url: "/v1/messages",
      headers: { "x-api-key": "caller-key" },
      error: { type: "error", error: { type: "invalid_request_error" } },
    },
    {
      url: "/v1/messages/count_tokens",
      headers: { "x-api-key": "caller-key" },
      error: { type: "error", error: { type: "invalid_request_error" } },
    },
    {
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      error: { error: { type: "invalid_request_error", code: "invalid_request" } },
    },
  ])("returns a protocol-native 400 for malformed JSON at $url", async (testCase) => {
    let upstreamCalls = 0;
    const privateFragment = "private-malformed-fragment";
    const app = createApp({}, async () => {
      upstreamCalls++;
      throw new Error("Unexpected upstream call");
    });

    const response = await app.inject({
      method: "POST",
      url: testCase.url,
      headers: { "content-type": "application/json", ...testCase.headers },
      payload: `{"model":"${privateFragment}"`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject(testCase.error);
    expect(response.body).not.toContain(privateFragment);
    expect(response.body).not.toContain("FST_ERR_CTP_INVALID_JSON_BODY");
    expect(upstreamCalls).toBe(0);
  });

  it.each([
    {
      url: "/v1/messages",
      headers: { "x-api-key": "caller-key" },
      payload: { model: "vendor/model-1", max_tokens: 1, messages: [] },
      type: "request_too_large",
    },
    {
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: "vendor/model-1", input: "hello" },
      type: "invalid_request_error",
    },
  ])("returns a protocol-native 413 for $url", async (testCase) => {
    const app = createApp({ BODY_LIMIT_BYTES: "16" });

    const response = await app.inject({
      method: "POST",
      url: testCase.url,
      headers: { "content-type": "application/json", ...testCase.headers },
      payload: testCase.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { type: testCase.type } });
    expect(response.body).not.toContain(JSON.stringify(testCase.payload));
  });

  it("preserves extension fields for semantic decoder validation", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer caller-key",
      },
      payload: { model: "vendor/model-1", future_extension: "must-not-strip" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { type: "invalid_request_error", code: "invalid_request" },
    });
  });
});

describe("stream lifecycle", () => {
  it("returns an HTTP error when the upstream sends no first byte", async () => {
    let upstreamAborted = false;
    const app = createApp(
      {
        ANTHROPIC_PING_INTERVAL_MS: "1",
        UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "5",
        UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "50",
      },
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        return new Response(new ReadableStream<Uint8Array>({}), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).not.toContain("event: ping");
    expect(response.json()).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(upstreamAborted).toBe(true);
  });

  it("emits a stream error when the upstream becomes idle after starting", async () => {
    const bytes = new TextEncoder().encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_idle","model":"vendor/model-1"}}\n\n',
    );
    let upstreamAborted = false;
    const app = createApp(
      { UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "50", UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "5" },
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("event: error");
    expect(upstreamAborted).toBe(true);
  });

  it("uses the Responses stream error envelope after an idle timeout", async () => {
    const bytes = new TextEncoder().encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_idle","model":"vendor/model-1"}}\n\n',
    );
    let upstreamAborted = false;
    const app = createApp(
      { UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "50", UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "5" },
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
      payload: {
        model: "vendor/model-1",
        stream: true,
        input: "hello",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: response.created");
    expect(response.body).toContain("event: error");
    expect(response.body).toContain('"code":"upstream_stream_error"');
    expect(upstreamAborted).toBe(true);
  });

  it("propagates a real client socket disconnect to the upstream signal", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    const app = createApp({}, async (_input, init) => {
      markUpstreamStarted?.();
      init?.signal?.addEventListener("abort", () => markUpstreamAborted?.(), { once: true });
      return new Response(new ReadableStream<Uint8Array>({}), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    const body = JSON.stringify({
      model: "vendor/model-1",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-api-key": "caller-key",
      },
    });
    client.on("error", () => undefined);
    client.end(body);

    await upstreamStarted;
    client.destroy();
    await expect(
      Promise.race([
        upstreamAborted,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Upstream was not aborted after disconnect")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      protocol: "Anthropic",
      path: "/v1/messages",
      headers: { "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [
          { role: "user", content: "use sleep" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "sleep", input: { seconds: 3 } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }],
          },
        ],
      },
      firstEvent: "event: message_start",
    },
    {
      protocol: "Responses",
      path: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: "vendor/model-1", input: "hello", stream: true },
      firstEvent: "event: response.created",
    },
  ])("does not write headers again after a streaming $protocol client disconnects", async (testCase) => {
    const upstreamBytes = new TextEncoder().encode(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_disconnect","model":"vendor/model-1"}}\n\n',
    );
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    const activeStreamRemoval = observeNextActiveStreamRemoval();
    const app = createApp({}, async (_input, init) => {
      init?.signal?.addEventListener("abort", () => markUpstreamAborted?.(), { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(upstreamBytes);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    const duplicateWriteHeads: number[] = [];
    const originalWriteHead = ServerResponse.prototype.writeHead;
    const writeHead = vi.spyOn(ServerResponse.prototype, "writeHead").mockImplementation(function (
      this: ServerResponse,
      ...arguments_: Parameters<typeof originalWriteHead>
    ) {
      if (this.headersSent) {
        duplicateWriteHeads.push(this.statusCode);
      }
      return Reflect.apply(originalWriteHead, this, arguments_);
    });

    const body = JSON.stringify(testCase.payload);
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: testCase.path,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...testCase.headers,
      },
    });
    client.on("error", () => undefined);

    try {
      const receivedFirstEvent = new Promise<void>((resolve, reject) => {
        client.on("response", (response) => {
          let received = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            received += chunk;
            if (received.includes(testCase.firstEvent)) {
              resolve();
              response.destroy();
            }
          });
          response.on("error", () => undefined);
        });
        client.on("error", reject);
      });
      client.end(body);

      await receivedFirstEvent;
      await expect(
        Promise.race([
          upstreamAborted,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Upstream was not aborted after disconnect")), 500),
          ),
        ]),
      ).resolves.toBeUndefined();
      await expect(
        Promise.race([
          activeStreamRemoval.removed,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Streaming handler did not finish after disconnect")),
              500,
            ),
          ),
        ]),
      ).resolves.toBeUndefined();
      expect(duplicateWriteHeads).toEqual([]);
    } finally {
      client.destroy();
      writeHead.mockRestore();
      activeStreamRemoval.restore();
    }
  });

  it.each([
    {
      protocol: "Anthropic",
      path: "/v1/messages",
      headers: { "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    },
    {
      protocol: "Responses",
      path: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: "vendor/model-1", input: "hello", stream: true },
    },
  ])("finishes a $protocol stream after a backpressured client disconnects", async (testCase) => {
    const encoder = new TextEncoder();
    const floodAllowed = Promise.withResolvers<void>();
    let upstreamFrame = 0;
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    const activeStreamRemoval = observeNextActiveStreamRemoval();
    const app = createApp({}, async (_input, init) => {
      init?.signal?.addEventListener("abort", () => markUpstreamAborted?.(), { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (upstreamFrame === 0) {
              upstreamFrame++;
              controller.enqueue(
                encoder.encode(
                  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_backpressure","model":"vendor/model-1"}}\n\n',
                ),
              );
              return;
            }
            await floodAllowed.promise;
            if (upstreamFrame === 1) {
              upstreamFrame++;
              controller.enqueue(
                encoder.encode(
                  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_backpressure","role":"assistant","content":[]}}\n\n',
                ),
              );
              return;
            }
            controller.enqueue(
              encoder.encode(
                `event: response.output_text.delta\ndata: ${JSON.stringify({
                  type: "response.output_text.delta",
                  output_index: 0,
                  delta: "x".repeat(64 * 1024),
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    const backpressure = Promise.withResolvers<void>();
    let clientResponse: import("node:http").IncomingMessage | undefined;
    let blockedResponse: ServerResponse | undefined;
    const originalWrite = ServerResponse.prototype.write;
    const write = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...arguments_: Parameters<typeof originalWrite>
    ) {
      const canWrite = Reflect.apply(originalWrite, this, arguments_);
      if (!canWrite && blockedResponse === undefined) {
        blockedResponse = this;
        backpressure.resolve();
        clientResponse?.destroy();
      }
      return canWrite;
    });

    const body = JSON.stringify(testCase.payload);
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: testCase.path,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...testCase.headers,
      },
    });
    client.on("error", () => undefined);
    let activeStreamReleased = false;

    try {
      const responseReceived = new Promise<void>((resolve, reject) => {
        client.on("response", (response) => {
          clientResponse = response;
          response.on("error", () => undefined);
          response.pause();
          floodAllowed.resolve();
          resolve();
        });
        client.on("error", reject);
      });
      client.end(body);

      await responseReceived;
      await expect(
        Promise.race([
          backpressure.promise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SSE response did not become backpressured")), 1_000),
          ),
        ]),
      ).resolves.toBeUndefined();
      await expect(
        Promise.race([
          upstreamAborted,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Upstream was not aborted after disconnect")), 500),
          ),
        ]),
      ).resolves.toBeUndefined();

      activeStreamReleased = await Promise.race([
        activeStreamRemoval.removed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(activeStreamReleased).toBe(true);
    } finally {
      clientResponse?.destroy();
      client.destroy();
      if (!activeStreamReleased) {
        blockedResponse?.emit("error", new Error("Release backpressured SSE test write"));
        await activeStreamRemoval.removed;
      }
      write.mockRestore();
      activeStreamRemoval.restore();
    }
  });

  it("propagates a real non-stream client disconnect to the upstream signal", async () => {
    let markUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    let markUpstreamAborted: (() => void) | undefined;
    const upstreamAborted = new Promise<void>((resolve) => {
      markUpstreamAborted = resolve;
    });
    const app = createApp({}, async (_input, init) => {
      markUpstreamStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            markUpstreamAborted?.();
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP server address");
    }

    const body = JSON.stringify({
      model: "vendor/model-1",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    });
    const client = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-api-key": "caller-key",
      },
    });
    client.on("error", () => undefined);
    client.end(body);

    await upstreamStarted;
    client.destroy();
    await expect(
      Promise.race([
        upstreamAborted,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Upstream was not aborted after disconnect")), 500),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  it("aborts an upstream stream without exposing oversized tool arguments", async () => {
    const privateArguments = "private-tool-arguments";
    const body = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_limit","model":"vendor/model-1"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"limited","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"abc"}\n\n',
      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: privateArguments })}\n\n`,
    ].join("");
    let upstreamAborted = false;
    let bodyCancelled = false;
    const app = createApp(
      {
        UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES: "3",
        UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES: "3",
      },
      async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
      payload: { model: "vendor/model-1", stream: true, input: "hello" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":"abc"');
    expect(response.body).toContain('"code":"TOOL_ARGUMENTS_TOO_LARGE"');
    expect(response.body).not.toContain(privateArguments);
    expect(upstreamAborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  it("aborts an oversized upstream SSE frame without exposing its contents", async () => {
    const privateFrame = "private-frame-content".repeat(10);
    const body = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_limit","model":"vendor/model-1"}}\n\n',
      `event: response.output_text.delta\ndata: ${privateFrame}`,
    ].join("");
    let upstreamAborted = false;
    let bodyCancelled = false;
    const app = createApp({ UPSTREAM_SSE_FRAME_LIMIT_BYTES: "160" }, async (_input, init) => {
      init?.signal?.addEventListener("abort", () => {
        upstreamAborted = true;
      });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
      payload: { model: "vendor/model-1", stream: true, input: "hello" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: response.created");
    expect(response.body).toContain('"code":"upstream_stream_error"');
    expect(response.body).not.toContain(privateFrame);
    expect(upstreamAborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  it("aborts an active upstream stream before app shutdown completes", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let upstreamAborted = false;
    const app = createApp({}, async (_input, init) => {
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Missing upstream abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });

    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    await started;

    await app.close();
    const response = await responsePromise;

    expect(upstreamAborted).toBe(true);
    expect(response.statusCode).toBe(500);
  });
});

describe("Web Search execution", () => {
  it.each([
    false,
    true,
  ])("executes Anthropic built-in search with an empty provider result for stream=%s", async (stream) => {
    const upstreamBodies: Record<string, unknown>[] = [];
    let round = 0;
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push((await request.json()) as Record<string, unknown>);
      round += 1;
      if (round === 1) {
        return Response.json({
          id: "resp_search",
          model: "vendor/model-1",
          status: "completed",
          output: [
            {
              id: "fc_search",
              type: "function_call",
              status: "completed",
              call_id: "call_search",
              name: INTERNAL_WEB_SEARCH_TOOL_NAME,
              arguments: '{"query":"latest news"}',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1 },
        });
      }
      return Response.json({
        id: "resp_final",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            id: "msg_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "No results found.", annotations: [] }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream,
        messages: [{ role: "user", content: "search" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: INTERNAL_WEB_SEARCH_TOOL_NAME,
        }),
      ]),
    );
    expect(upstreamBodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_search",
          output: JSON.stringify({
            ok: true,
            result_count: 0,
            results: [],
            message: "Web search completed successfully with 0 results. This is not an API error.",
          }),
        }),
      ]),
    );
    if (stream) {
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("No results found.");
      expect(response.body).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
    } else {
      expect(response.json()).toMatchObject({
        content: [
          { type: "text", text: "No results found." },
          {
            type: "server_tool_use",
            id: "srvtoolu_ai_hub_0",
            name: "web_search",
            input: { query: "latest news" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_ai_hub_0",
            content: [],
          },
        ],
        stop_reason: "end_turn",
        usage: { server_tool_use: { web_search_requests: 1 } },
      });
    }
  });

  it("keeps built-in Web Search in Anthropic input token counting", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamBody = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({ object: "response.input_tokens", input_tokens: 3 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        messages: [{ role: "user", content: "search" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 3 });
    expect(upstreamBody?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          name: INTERNAL_WEB_SEARCH_TOOL_NAME,
        }),
      ]),
    );
  });

  it("does not classify a function named web_search as built-in search", async () => {
    let upstreamCalls = 0;
    const app = createApp({}, async () => {
      upstreamCalls += 1;
      return Response.json({ object: "response.input_tokens", input_tokens: 3 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        messages: [{ role: "user", content: "search" }],
        tools: [
          {
            type: "custom",
            name: "web_search",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 3 });
    expect(upstreamCalls).toBe(1);
  });
});

describe("Anthropic Messages conversion", () => {
  it("converts a non-stream request through Responses and preserves the credential and model", async () => {
    let upstreamRequest: Request | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamRequest = new Request(input, init);
      return Response.json({
        id: "resp_123",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello back", annotations: [] }],
          },
        ],
        usage: { input_tokens: 7, output_tokens: 3 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "resp_123",
      type: "message",
      role: "assistant",
      model: "vendor/model-1",
      content: [{ type: "text", text: "hello back" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    expect(upstreamRequest?.url).toBe("https://gateway.example.test/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer caller-key");
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-1",
      stream: false,
      store: false,
      reasoning: { effort: "medium" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
  });

  it("returns a clean 400 without calling upstream for image content in tool results", async () => {
    const upstreamFetch = vi.fn(async () => {
      throw new Error("upstream must not be called");
    });
    const app = createApp({}, upstreamFetch);

    const payload = {
      model: "vendor/model-1",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "screenshot" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
      ],
    };

    const nonStream = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload,
    });
    expect(nonStream.statusCode).toBe(400);
    expect(nonStream.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });

    const stream = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: { ...payload, stream: true },
    });
    expect(stream.statusCode).toBe(400);
    expect(stream.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });

    const counted = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: { model: payload.model, messages: payload.messages },
    });
    expect(counted.statusCode).toBe(400);
    expect(counted.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });

    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("converts an upstream refusal to text with a refusal stop reason", async () => {
    const app = createApp({}, async () =>
      Response.json({
        id: "resp_refusal",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I cannot help with that" }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 6 },
      }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      content: [{ type: "text", text: "I cannot help with that" }],
      stop_reason: "refusal",
      stop_sequence: null,
    });
  });

  it("omits unsigned Anthropic thinking while forwarding matched Responses call items", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamBody = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({
        id: "resp_tool_result",
        model: "vendor/model-1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "finished", annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        messages: [
          { role: "user", content: "use sleep" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan", signature: "" },
              { type: "text", text: "calling" },
              { type: "tool_use", id: "call_1", name: "sleep", input: { seconds: 3 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }],
          },
        ],
        tools: [
          {
            name: "sleep",
            input_schema: {
              type: "object",
              properties: { seconds: { type: "number" } },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      content: [{ type: "text", text: "finished" }],
      stop_reason: "end_turn",
    });
    expect(upstreamBody?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "use sleep" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "calling" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "sleep",
        arguments: '{"seconds":3}',
      },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ]);
  });

  it("converts a Responses stream into Anthropic SSE", async () => {
    let upstreamRequest: Request | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamRequest = new Request(input, init);
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream","model":"vendor/model-1"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_stream","role":"assistant","content":[]}}\n\n',
        'event: response.content_part.added\ndata: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hello stream"}\n\n',
        'event: response.content_part.done\ndata: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"hello stream","annotations":[]}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_stream","role":"assistant","content":[{"type":"output_text","text":"hello stream","annotations":[]}]}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","model":"vendor/model-1","status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("event: content_block_start");
    expect(response.body).toContain('"type":"text_delta","text":"hello stream"');
    expect(response.body).toContain("event: message_delta");
    expect(response.body).toContain("event: message_stop");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer caller-key");
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-1",
      stream: true,
      store: false,
      reasoning: { effort: "high" },
    });
  });

  it("converts a Responses stream refusal into an Anthropic text block with refusal stop reason", async () => {
    const app = createApp({}, async () => {
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_refusal","model":"vendor/model-1"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_refusal","role":"assistant","status":"in_progress","content":[]}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_refusal","role":"assistant","status":"completed","content":[{"type":"refusal","refusal":"I cannot help with that"}]}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_refusal","model":"vendor/model-1","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":7}}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain('"type":"text_delta","text":"I cannot help with that"');
    expect(response.body).toContain('"stop_reason":"refusal"');
    expect(response.body).toContain("event: message_stop");
    expect(response.body).not.toContain("event: error");
  });

  it.each([
    "null",
    "[]",
    '"scalar"',
  ])("fails an Anthropic Responses stream whose tool input is non-object JSON %s", async (argumentsJson) => {
    const app = createApp({}, async () => {
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_invalid_tool","model":"vendor/model-1"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"invalid","arguments":""}}\n\n',
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: argumentsJson })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "invalid", arguments: argumentsJson } })}\n\n`,
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "call" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("event: content_block_stop");
  });

  it.each([
    "null",
    "[]",
    '"scalar"',
  ])("fails an Anthropic Chat fallback stream whose tool input is non-object JSON %s", async (argumentsJson) => {
    const app = createApp({}, async (input) => {
      if (String(input).endsWith("/responses")) {
        return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
      }
      const body = [
        `data: ${JSON.stringify({ id: "chatcmpl_invalid_tool", model: "vendor/model-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "invalid", arguments: argumentsJson } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ id: "chatcmpl_invalid_tool", model: "vendor/model-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "call" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("event: content_block_stop");
  });

  it("applies Claude Code thinking and Read shims to an Anthropic stream", async () => {
    const app = createApp({}, async () => {
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_shims","model":"vendor/model-1"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"reasoning_1","summary":[]}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"plan"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"reasoning_1","summary":[{"type":"summary_text","text":"plan"}]}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"file_path\\":\\"/tmp/a\\","}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"pages\\":\\"\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a\\",\\"pages\\":\\"\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_shims","model":"vendor/model-1","status":"completed","output":[],"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "caller-key",
        "user-agent": "claude-cli/2.1.220 (external, cli)",
      },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "read" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toMatch(/"type":"signature_delta","signature":"[A-Za-z0-9+/]{48}"/);
    expect(response.body).toContain(
      '"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/a\\"}"',
    );
    expect(response.body).not.toContain('\\"pages\\":\\"\\"');
  });

  it("emits named Anthropic pings while Read arguments are buffered", async () => {
    const encoder = new TextEncoder();
    const first = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_ping","model":"vendor/model-1"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file_path\\":\\"/tmp/a\\","}\n\n',
    ].join("");
    const last = [
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"\\"pages\\":\\"\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"Read","arguments":"{\\"file_path\\":\\"/tmp/a\\",\\"pages\\":\\"\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ].join("");
    const app = createApp(
      {
        ANTHROPIC_PING_INTERVAL_MS: "5",
        UPSTREAM_STREAM_IDLE_TIMEOUT_MS: "100",
      },
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(first));
              setTimeout(() => {
                controller.enqueue(encoder.encode(last));
                controller.close();
              }, 25);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "caller-key",
        "user-agent": "claude-cli/2.1.220 (external, cli)",
      },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "read" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain('event: ping\ndata: {"type":"ping"}');
    expect(response.body).toContain(
      '"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/a\\"}"',
    );
  });

  it("falls back to a Chat stream before any Responses semantic event", async () => {
    const upstreamRequests: Request[] = [];
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      upstreamRequests.push(request);
      if (request.url.endsWith("/responses")) {
        return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
      }
      const body = [
        'data: {"id":"chatcmpl_stream","model":"vendor/model-1","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        'data: {"id":"chatcmpl_stream","model":"vendor/model-1","choices":[{"index":0,"delta":{"content":"fallback stream"},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"chatcmpl_stream","model":"vendor/model-1","choices":[],"usage":{"prompt_tokens":6,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"type":"text_delta","text":"fallback stream"');
    expect(response.body).toContain('"input_tokens":6,"output_tokens":2');
    expect(upstreamRequests.map((request) => request.url)).toEqual([
      "https://gateway.example.test/v1/responses",
      "https://gateway.example.test/v1/chat/completions",
    ]);
    expect(await upstreamRequests[1]?.json()).toMatchObject({
      model: "vendor/model-1",
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("does not fall back a stream for an ambiguous Responses 404", async () => {
    let attemptCount = 0;
    const app = createApp({}, async () => {
      attemptCount += 1;
      return Response.json({ error: { code: "model_not_found" } }, { status: 404 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "missing-model",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(attemptCount).toBe(1);
  });

  it("does not fall back after a Responses semantic event has been written", async () => {
    let attemptCount = 0;
    const app = createApp({}, async () => {
      attemptCount += 1;
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_partial","model":"vendor/model-1"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"invalid without item"}\n\n',
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("event: error");
    expect(attemptCount).toBe(1);
  });

  it("falls back to Chat when Responses explicitly reports an unsupported endpoint", async () => {
    const upstreamRequests: Request[] = [];
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      upstreamRequests.push(request);
      if (request.url.endsWith("/responses")) {
        return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
      }
      return Response.json({
        id: "chatcmpl_123",
        model: "vendor/model-1",
        choices: [
          {
            message: { role: "assistant", content: "fallback answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        output_config: { effort: "xhigh" },
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "chatcmpl_123",
      content: [{ type: "text", text: "fallback answer" }],
      usage: { input_tokens: 9, output_tokens: 4 },
    });
    expect(upstreamRequests.map((request) => request.url)).toEqual([
      "https://gateway.example.test/v1/responses",
      "https://gateway.example.test/v1/chat/completions",
    ]);
    expect(await upstreamRequests[0]?.json()).toMatchObject({
      reasoning: { effort: "xhigh" },
    });
    expect(await upstreamRequests[1]?.json()).toMatchObject({
      model: "vendor/model-1",
      stream: false,
      reasoning_effort: "xhigh",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });
  });

  it("preserves unsigned thinking and matched tool results in Chat fallback", async () => {
    let chatBody: Record<string, unknown> | undefined;
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/responses")) {
        return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
      }
      chatBody = (await request.json()) as Record<string, unknown>;
      return Response.json({
        id: "chatcmpl_tool_result",
        model: "vendor/model-1",
        choices: [
          {
            message: { role: "assistant", content: "finished" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        messages: [
          { role: "user", content: "use sleep" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan", signature: "" },
              { type: "tool_use", id: "call_1", name: "sleep", input: { seconds: 3 } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }],
          },
        ],
        tools: [
          {
            name: "sleep",
            input_schema: {
              type: "object",
              properties: { seconds: { type: "number" } },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      content: [{ type: "text", text: "finished" }],
      stop_reason: "end_turn",
    });
    expect(chatBody?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "use sleep" }],
      },
      {
        role: "assistant",
        reasoning_content: "plan",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "sleep", arguments: '{"seconds":3}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);
  });

  it("does not send cache write metadata through the generic upstream profile", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      upstreamBodies.push((await request.json()) as Record<string, unknown>);
      if (request.url.endsWith("/responses")) {
        return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 404 });
      }
      return Response.json({
        id: "chatcmpl_cache",
        model: "vendor/model-1",
        choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": "caller-key",
        "user-agent": "claude-cli/2.1.220 (external, cli)",
      },
      payload: {
        model: "vendor/model-1",
        max_tokens: 64,
        system: [
          {
            type: "text",
            text: "stable system",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
          },
          { role: "user", content: "tail" },
        ],
        tools: [
          {
            name: "weather",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamBodies).toHaveLength(2);
    for (const body of upstreamBodies) {
      const wire = JSON.stringify(body);
      expect(wire).not.toContain("cache_control");
      expect(wire).not.toContain("prompt_cache_key");
      expect(wire).not.toContain("prompt_cache_options");
      expect(wire).not.toContain("prompt_cache_breakpoint");
    }
  });

  it("does not fall back to Chat for an ambiguous Responses 404", async () => {
    let attemptCount = 0;
    const app = createApp({}, async () => {
      attemptCount += 1;
      return Response.json({ error: { code: "model_not_found" } }, { status: 404 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "missing-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
    expect(attemptCount).toBe(1);
  });
});

describe("Anthropic token counting", () => {
  it("delegates exact input token counting to Responses input_tokens", async () => {
    let upstreamRequest: Request | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamRequest = new Request(input, init);
      return Response.json({ object: "response.input_tokens", input_tokens: 42 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "count me" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ input_tokens: 42 });
    expect(upstreamRequest?.url).toBe("https://gateway.example.test/v1/responses/input_tokens");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer caller-key");
    const upstreamBody = await upstreamRequest?.json();
    expect(upstreamBody).toMatchObject({
      model: "vendor/model-1",
      reasoning: { effort: "low" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "count me" }],
        },
      ],
    });
    expect(upstreamBody).not.toHaveProperty("store");
    expect(upstreamBody).not.toHaveProperty("stream");
  });

  it("keeps token counting free of cache write metadata", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamBody = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({ object: "response.input_tokens", input_tokens: 9 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: {
        "content-type": "application/json",
        "x-api-key": "caller-key",
        "user-agent": "claude-cli/2.1.220 (external, cli)",
      },
      payload: {
        model: "vendor/model-1",
        system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "count", cache_control: { type: "ephemeral" } }],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const wire = JSON.stringify(upstreamBody);
    expect(wire).not.toContain("cache_control");
    expect(wire).not.toContain("prompt_cache_key");
    expect(wire).not.toContain("prompt_cache_options");
    expect(wire).not.toContain("prompt_cache_breakpoint");
  });

  it("returns 501 without Chat fallback when input_tokens is unsupported", async () => {
    let attemptCount = 0;
    const app = createApp({}, async () => {
      attemptCount += 1;
      return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 501 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { "content-type": "application/json", "x-api-key": "caller-key" },
      payload: {
        model: "vendor/model-1",
        messages: [{ role: "user", content: "count me" }],
      },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
    expect(attemptCount).toBe(1);
  });
});

describe("OpenAI Responses conversion", () => {
  it("normalizes a non-stream request and response without Chat fallback", async () => {
    let upstreamRequest: Request | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamRequest = new Request(input, init);
      return Response.json({
        id: "resp_456",
        object: "response",
        created_at: 1_722_000_000,
        model: "vendor/model-2",
        status: "completed",
        incomplete_details: null,
        output: [
          {
            id: "msg_456",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "response answer", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer responses-key", "content-type": "application/json" },
      payload: {
        model: "vendor/model-2",
        input: "hello",
        stream: false,
        store: true,
        previous_response_id: "resp_previous",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: "resp_456",
      object: "response",
      model: "vendor/model-2",
      status: "completed",
      output: [
        {
          id: "msg_456",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "response answer", annotations: [] }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    expect(upstreamRequest?.url).toBe("https://gateway.example.test/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer responses-key");
    expect(await upstreamRequest?.json()).toMatchObject({
      model: "vendor/model-2",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
      stream: false,
      store: true,
      previous_response_id: "resp_previous",
    });
  });

  it("suppresses caller prompt cache keys for the generic profile", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const app = createApp({}, async (input, init) => {
      upstreamBody = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({
        id: "resp_cache_none",
        object: "response",
        model: "vendor/model-2",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer responses-key", "content-type": "application/json" },
      payload: {
        model: "vendor/model-2",
        input: "hello",
        prompt_cache_key: "caller-cache-key",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(upstreamBody).not.toHaveProperty("prompt_cache_key");
  });

  it("normalizes a Responses text stream without Chat fallback", async () => {
    const urls: string[] = [];
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream_2","model":"vendor/model-2"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_stream_2","type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"delta":"normalized"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_stream_2","type":"message","role":"assistant","content":[{"type":"output_text","text":"normalized","annotations":[]}]}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream_2","model":"vendor/model-2","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer responses-key", "content-type": "application/json" },
      payload: { model: "vendor/model-2", input: "hello", stream: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: response.created");
    expect(response.body).toContain("event: response.output_text.delta");
    expect(response.body).toContain('"item_id":"msg_stream_2"');
    expect(response.body).toContain("event: response.completed");
    expect(response.body).toContain('"text":"normalized"');
    expect(response.body).toContain("data: [DONE]\n\n");
    expect(urls).toEqual(["https://gateway.example.test/v1/responses"]);
  });

  it("normalizes reasoning, citations, and function calls in a Responses stream", async () => {
    const app = createApp({}, async () => {
      const body = [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_rich","model":"vendor/model-2"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"plan"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[{"type":"summary_text","text":"plan"}],"encrypted_content":"encrypted-real"}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"delta":"answer"}\n\n',
        'event: response.output_text.annotation.added\ndata: {"type":"response.output_text.annotation.added","item_id":"msg_1","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","url":"https://example.test/source","title":"Source","start_index":0,"end_index":6}}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.test/source","title":"Source","start_index":0,"end_index":6}]}]}}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"weather","arguments":""}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"city\\":\\"Paris\\"}"}\n\n',
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"weather","arguments":"{\\"city\\":\\"Paris\\"}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_rich","model":"vendor/model-2","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":4,"output_tokens_details":{"reasoning_tokens":1}}}}\n\n',
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer responses-key", "content-type": "application/json" },
      payload: { model: "vendor/model-2", input: "hello", stream: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"encrypted_content":"encrypted-real"');
    expect(response.body).toContain("event: response.reasoning_summary_text.delta");
    expect(response.body).toContain("event: response.output_text.annotation.added");
    expect(response.body).toContain('"url":"https://example.test/source"');
    expect(response.body).toContain("event: response.function_call_arguments.delta");
    expect(response.body).toContain('"arguments":"{\\"city\\":\\"Paris\\"}"');
    expect(response.body).toContain('"reasoning_tokens":1');
    expect(response.body).toContain("data: [DONE]\n\n");
  });

  it("returns an OpenAI error and never calls Chat when Responses is unavailable", async () => {
    const urls: string[] = [];
    const app = createApp({}, async (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      return Response.json({ error: { code: "unsupported_endpoint" } }, { status: 501 });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer responses-key", "content-type": "application/json" },
      payload: { model: "vendor/model-2", input: "hello" },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({
      error: { type: "server_error", code: "upstream_error" },
    });
    expect(urls).toEqual(["https://gateway.example.test/v1/responses"]);
  });
});

describe("Claude Code version gate", () => {
  it("rejects an accepted client profile outside the configured range before routing", async () => {
    const app = createApp({ CLAUDE_CODE_MIN_VERSION: "2.1.63" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "test-key",
      },
      payload: {
        model: "test-model",
        max_tokens: 32,
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=2.1.62.04c; cc_entrypoint=cli;",
          },
        ],
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(response.json().request_id).toMatch(/^req_/);
  });
});
