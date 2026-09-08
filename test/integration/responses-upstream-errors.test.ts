import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const failures = [
  {
    error: { code: "item_not_found", message: "private-item" },
    name: "不存在的输出项",
  },
  {
    error: { message: "Item private-item does not exist" },
    name: "缺失错误码的输出项错误",
  },
  {
    error: { message: "No tool call found for function call output with call_id private-call" },
    name: "工具调用不存在",
  },
  {
    error: { message: "item_reference is not supported: private-item" },
    name: "不支持引用",
  },
  {
    error: { code: "private-code", message: "private-message" },
    name: "未知错误码",
  },
  {
    error: { code: "invalid_value", message: { private: "private-message" } },
    name: "非字符串错误消息",
  },
];

describe("Responses 上游错误清洗", () => {
  it.each(
    [false, true].flatMap((stream) => failures.map((failure) => ({ stream, ...failure }))),
  )("清洗$name且不重试或输出临时日志，stream=$stream", async ({ stream, error }) => {
    const logs: string[] = [];
    const upstreamFetch = vi.fn(async () =>
      Response.json(
        { error },
        {
          status: 400,
          headers: { "x-request-id": "private-upstream-request" },
        },
      ),
    );
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: {
        level: "info",
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
      upstreamFetch,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: {
        model: "model-test",
        stream,
        input: "private-prompt",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(response.json().error).toMatchObject({ type: "invalid_request_error" });
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
  });

  it.each([
    false,
    true,
  ])("无效上游响应返回清洗后的 500 且不输出临时日志，stream=%s", async (stream) => {
    const logs: string[] = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: {
        level: "info",
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
      upstreamFetch: async () => Response.json({}),
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: { model: "model-test", input: "private-prompt", stream },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ type: "server_error" });
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
  });
});
