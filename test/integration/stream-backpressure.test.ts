import { type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { ActiveStreamRegistry } from "../../src/stream/active-streams.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

const routes = ["/v1/responses", "/v1/chat/completions", "/v1/messages"];

describe("cancellation with a connected but non-reading SSE client", () => {
  it.each(
    routes.flatMap((url) => ["timeout", "shutdown"].map((reason) => ({ url, reason }))),
  )("releases $url on $reason and stops writing heartbeats under backpressure", async ({
    url,
    reason,
  }) => {
    const flood = Promise.withResolvers<void>();
    let upstreamAborted = false;
    let frames = 0;
    let active = 0;
    let response: ServerResponse | undefined;
    let heartbeats = 0;
    let blockedHeartbeats = 0;
    const originalAdd = ActiveStreamRegistry.prototype.add;
    vi.spyOn(ActiveStreamRegistry.prototype, "add").mockImplementation(function (
      this: ActiveStreamRegistry,
      controller,
    ) {
      active++;
      const remove = originalAdd.call(this, controller);
      return () => {
        active--;
        remove();
      };
    });
    const app = buildApp({
      config: loadConfig({
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        SSE_HEARTBEAT_INTERVAL_MS: "20",
        ANTHROPIC_PING_INTERVAL_MS: "20",
        UPSTREAM_TIMEOUT_MS: reason === "timeout" ? "1500" : "10000",
        UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "67108864",
        UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES: "134217728",
      }),
      logger: false,
      upstreamFetch: async (_url, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
          },
          { once: true },
        );
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (frames > 0) await flood.promise;
              const delta =
                frames++ === 0 ? { role: "assistant" } : { content: "x".repeat(64 * 1024) };
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ id: "chat_backpressure", model: "m", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    apps.push(app);
    app.addHook("onRequest", async (_request, reply) => {
      response = reply.raw;
      const originalWrite = response.write;
      vi.spyOn(response, "write").mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<typeof originalWrite>
      ) {
        if (String(args[0]) === ": ping\n\n") {
          heartbeats++;
          if (this.writableNeedDrain) blockedHeartbeats++;
        }
        return Reflect.apply(originalWrite, this, args);
      });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const ready = Promise.withResolvers<void>();
    let incoming: IncomingMessage | undefined;
    const client = httpRequest(
      `${address}${url}`,
      {
        method: "POST",
        headers: { authorization: "Bearer caller-key", "content-type": "application/json" },
      },
      (received) => {
        incoming = received;
        received.on("error", () => undefined);
        received.pause();
        flood.resolve();
        ready.resolve();
      },
    );
    client.on("error", (error) => ready.reject(error));
    try {
      client.end(
        JSON.stringify({
          model: "m",
          stream: true,
          ...(url === "/v1/responses"
            ? { input: "hello" }
            : { max_tokens: 100000, messages: [{ role: "user", content: "hello" }] }),
        }),
      );
      await ready.promise;
      await vi.waitFor(() => {
        expect(response?.writableNeedDrain).toBe(true);
        expect(frames).toBeGreaterThan(1);
      });
      await delay(80);
      expect(response?.writableNeedDrain).toBe(true);
      expect(incoming?.destroyed).toBe(false);
      const closing = reason === "shutdown" ? app.close() : undefined;
      await vi.waitFor(
        () => {
          expect(upstreamAborted).toBe(true);
          expect(response?.destroyed).toBe(true);
          expect(active).toBe(0);
        },
        { timeout: 3000 },
      );
      expect(blockedHeartbeats).toBe(0);
      const finalHeartbeats = heartbeats;
      await delay(80);
      expect(heartbeats).toBe(finalHeartbeats);
      await closing;
    } finally {
      flood.resolve();
      incoming?.destroy();
      client.destroy();
      response?.destroy();
    }
  });
});
