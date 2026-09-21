import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Environment } from "../../src/config.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
const origin = "http://localhost:5173";

function createApp(environment: Environment = {}, upstreamFetch?: typeof fetch) {
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.example/v1", ...environment }),
    logger: false,
    ...(upstreamFetch ? { upstreamFetch } : {}),
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("browser CORS", () => {
  it.each([
    ["/v1/messages", "POST"],
    ["/v1/messages/count_tokens", "POST"],
    ["/v1/responses", "POST"],
    ["/responses", "POST"],
    ["/v1/chat/completions", "POST"],
    ["/chat/completions", "POST"],
    ["/v1/models", "GET"],
    ["/v1/usage", "GET"],
    ["/v1/conversations/conv_test", "DELETE"],
  ])("handles unauthenticated preflight for %s (%s)", async (url, method) => {
    const upstreamFetch = vi.fn<typeof fetch>();
    const app = createApp({}, upstreamFetch);
    const headers =
      "authorization,content-type,x-api-key,anthropic-version,anthropic-dangerous-direct-browser-access,x-stainless-lang";
    const response = await app.inject({
      method: "OPTIONS",
      url,
      headers: {
        origin,
        "access-control-request-method": method,
        "access-control-request-headers": headers,
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(
      response.headers["access-control-allow-methods"]?.split(",").map((value) => value.trim()),
    ).toContain(method);
    expect(response.headers["access-control-allow-headers"]).toBe(headers);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("preserves CORS headers on JSON success, auth errors, validation errors and 404s", async () => {
    const app = createApp();
    const responses = [
      await app.inject({ url: "/health/live", headers: { origin } }),
      await app.inject({ url: "/v1/models", headers: { origin } }),
      await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { origin, authorization: "Bearer test-key" },
        payload: {},
      }),
      await app.inject({ url: "/missing", headers: { origin } }),
    ];
    expect(responses.map((response) => response.statusCode)).toEqual([200, 401, 400, 404]);
    for (const response of responses) {
      expect(response.headers["access-control-allow-origin"]).toBe("*");
      expect(response.headers["access-control-expose-headers"]).toContain("retry-after");
    }
  });

  it("allows only exact configured origins and varies responses by origin", async () => {
    const app = createApp({ CORS_ORIGINS: `https://app.example, ${origin}` });
    for (const requestOrigin of [origin, "https://app.example", "https://app.example.evil"]) {
      const response = await app.inject({
        url: "/health/live",
        headers: { origin: requestOrigin },
      });
      expect(response.headers["access-control-allow-origin"]).toBe(
        requestOrigin.endsWith(".evil") ? undefined : requestOrigin,
      );
      expect(response.headers.vary).toContain("Origin");
    }
  });

  it.each([
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
  ])("keeps CORS headers when %s switches to SSE", async (url) => {
    const chunk = {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1234,
      model: "test-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
    };
    const app = createApp(
      {},
      async () =>
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await app.inject({
      method: "POST",
      url,
      headers: { origin, authorization: "Bearer test-key" },
      payload: {
        model: "test-model",
        stream: true,
        ...(url === "/v1/responses"
          ? { input: "hello" }
          : { max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.body).toContain("hello");
  });
});
