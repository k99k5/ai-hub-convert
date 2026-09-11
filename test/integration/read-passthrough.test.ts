import { createServer, request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createApp(
  upstreamFetch?: typeof globalThis.fetch,
  environment: Record<string, string> = {},
) {
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/api/v1",
      ...environment,
    }),
    logger: false,
    ...(upstreamFetch === undefined ? {} : { upstreamFetch }),
  });
  apps.push(app);
  return app;
}

const credentials = [
  { authorization: "Bearer caller-key" },
  { "x-api-key": "caller-key" },
  { authorization: "Bearer caller-key", "x-api-key": "caller-key" },
] as const;

describe("用量与模型读取透传", () => {
  it.each(
    ["usage", "models"].flatMap((path) => credentials.map((headers) => ({ path, headers }))),
  )("透传 $path 的凭据、原始查询和响应字节", async ({ path, headers }) => {
    const body =
      path === "usage"
        ? '{ "used": 9007199254740993, "remaining": null, "reset_at": "明天" }\n'
        : '{ "object": "list", "data": [{"id": "vendor/model", "name": "模型"}] }\n';
    const query = "?model=a%2Fb&model=c+d&empty=&flag&label=%E4%B8%AD&url=https%3A%2F%2Fother.test";
    const upstreamFetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://upstream.test/api/v1/${path}${query}`);
      expect(request.method).toBe("GET");
      expect(request.body).toBeNull();
      expect(request.redirect).toBe("error");
      expect(Object.fromEntries(request.headers)).toEqual({
        accept: "application/json",
        authorization: "Bearer caller-key",
      });
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "x-request-id": "upstream-request",
          "set-cookie": "upstream-session=private",
          "content-encoding": "gzip",
        },
      });
    });
    const app = createApp(upstreamFetch);
    const response = await app.inject({
      method: "GET",
      url: `/v1/${path}${query}`,
      headers: { ...headers, cookie: "session=private", "x-private-header": "private" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(body);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["x-request-id"]).toBe("upstream-request");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(Number(response.headers["content-length"])).toBe(Buffer.byteLength(body));
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 429, 500, 529])("保留上游 %s 错误正文且不重试", async (status) => {
    const body = '{ "error": { "code": "upstream_code", "message": "上游错误" } }\n';
    const upstreamFetch = vi.fn(
      async () =>
        new Response(body, {
          status,
          headers: { "content-type": "application/json", "retry-after": "60" },
        }),
    );
    const response = await createApp(upstreamFetch).inject({
      method: "GET",
      url: "/v1/usage",
      headers: credentials[0],
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).toBe(body);
    expect(response.headers["retry-after"]).toBe("60");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([204, 304])("保留 %s 空响应", async (status) => {
    const response = await createApp(async () => new Response(null, { status })).inject({
      method: "GET",
      url: "/v1/usage",
      headers: credentials[0],
    });
    expect(response.statusCode).toBe(status);
    expect(response.body).toBe("");
  });

  it("保留非 JSON 正文", async () => {
    const response = await createApp(
      async () =>
        new Response("接口未开放\n", { status: 404, headers: { "content-type": "text/plain" } }),
    ).inject({ method: "GET", url: "/v1/models", headers: credentials[0] });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("接口未开放\n");
    expect(response.headers["content-type"]).toBe("text/plain");
  });

  it.each([
    {},
    { authorization: "Basic private-key" },
    { authorization: "Bearer first-key", "x-api-key": "second-key" },
  ])("无效凭据在访问上游前拒绝：%j", async (headers) => {
    const upstreamFetch = vi.fn(async () => Response.json({}));
    const app = createApp(upstreamFetch);
    for (const path of ["usage", "models"]) {
      const response = await app.inject({ method: "GET", url: `/v1/${path}`, headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("invalid_api_key");
      expect(response.body).not.toMatch(/private-key|first-key|second-key/);
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("仅转发明确列出的 GET 路径", async () => {
    const upstreamFetch = vi.fn(async () => Response.json({}));
    const app = createApp(upstreamFetch);
    for (const url of ["/v1/unknown", "/v1/models/private", "/v1/usage/private"]) {
      const response = await app.inject({ method: "GET", url, headers: credentials[0] });
      expect(response.statusCode).toBe(404);
    }
    for (const method of ["POST", "DELETE", "HEAD"] as const) {
      for (const path of ["usage", "models"]) {
        const response = await app.inject({ method, url: `/v1/${path}`, headers: credentials[0] });
        expect(response.statusCode).toBe(404);
      }
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, declared: false },
    { status: 200, declared: true },
    { status: 429, declared: false },
    { status: 429, declared: true },
  ])("取消超限正文且不输出部分结果：%j", async ({ status, declared }) => {
    const cancel = vi.fn();
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("private-".repeat(8)));
            },
            cancel,
          }),
          { status, ...(declared ? { headers: { "content-length": "64" } } : {}) },
        ),
    );
    const app = createApp(upstreamFetch, {
      UPSTREAM_JSON_BODY_LIMIT_BYTES: status === 200 ? "16" : "1024",
      UPSTREAM_ERROR_BODY_LIMIT_BYTES: status === 200 ? "1024" : "16",
    });
    const response = await app.inject({ method: "GET", url: "/v1/usage", headers: credentials[0] });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("upstream_error");
    expect(response.body).not.toContain("private-");
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it("连接失败使用现有网关错误且不重试", async () => {
    const upstreamFetch = vi.fn(async () => {
      throw new Error("private-connection-error");
    });
    const response = await createApp(upstreamFetch).inject({
      method: "GET",
      url: "/v1/models",
      headers: credentials[0],
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("upstream_error");
    expect(response.body).not.toContain("private-");
    expect(upstreamFetch).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "disconnect"])("真实连接在 %s 时取消停滞的上游正文", async (mode) => {
    const received = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const upstream = createServer((_request, response) => {
      response.on("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"used":');
      received.resolve();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("上游测试端口不可用");
    try {
      const app = createApp(undefined, {
        UPSTREAM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        ALLOW_INSECURE_UPSTREAM: "true",
        UPSTREAM_TIMEOUT_MS: mode === "timeout" ? "250" : "5000",
      });
      if (mode === "timeout") {
        const response = await app.inject({
          method: "GET",
          url: "/v1/usage",
          headers: credentials[0],
        });
        await received.promise;
        expect(response.statusCode).toBe(500);
        expect(response.json().error.code).toBe("upstream_error");
        expect(response.body).not.toContain('"used"');
      } else {
        const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
        const request = httpRequest(`${baseUrl}/v1/models`, { headers: credentials[0] });
        request.on("error", () => {});
        request.end();
        await received.promise;
        request.destroy();
      }
      await closed.promise;
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
