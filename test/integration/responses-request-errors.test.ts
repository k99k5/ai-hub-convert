import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const logs: string[] = [];
  const upstreamFetch = vi.fn(async () =>
    Response.json({
      id: "resp_test",
      model: "model-test",
      status: "completed",
      output: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
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
  return { app, logs, upstreamFetch };
}

describe("Responses 请求错误处理", () => {
  it.each([
    { item: { type: "item_reference", id: null }, tag: "item_reference" },
    {
      item: {
        type: "function_call_output",
        call_id: "private-call",
        output: { secret: "private-output" },
      },
      tag: "function_call_output",
    },
    {
      item: {
        type: "reasoning",
        id: "private-id",
        summary: [{ type: "reasoning_text", text: "private-reasoning" }],
      },
      tag: "reasoning_text",
    },
    {
      item: { role: "user", content: [{ type: "input_file", file_id: "private-file" }] },
      tag: "input_file",
    },
    {
      item: {
        type: "function_call_output",
        call_id: "private-call",
        output: [{ type: "input_image", image_url: "private-image" }],
      },
      tag: "input_image",
    },
  ])("拒绝非法 $tag 内容且不访问上游或泄露请求内容", async ({ item }) => {
    const { app, logs, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: { model: "model-test", input: [{ role: "user", content: "private-prompt" }, item] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toMatchObject({ type: "invalid_request_error", code: "invalid_request" });
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("长历史末尾的非法内容也被拒绝，未知键名和枚举值不进入日志", async () => {
    const { app, logs, upstreamFetch } = setup();
    const content = Array.from({ length: 100 }, () => ({
      type: "input_text",
      text: "private-prompt",
    }));
    const input = Array.from({ length: 100 }, () => ({ role: "user", content }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: {
        model: "model-test",
        input: [
          ...input,
          {
            role: "user",
            content: [
              ...content,
              {
                type: "private-type",
                role: "private-role",
                text: "private-body".repeat(10000),
                "private-field": "private-value",
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request",
    });
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("拒绝未知顶层字段且不泄露字段名称和内容", async () => {
    const { app, logs, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: { model: "model-test", input: "private-prompt", "private-field": "private-value" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "invalid_request",
    });
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("合法请求和鉴权失败保持原行为且不输出临时日志，authenticated=%s", async (authenticated) => {
    const { app, logs, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authenticated ? { authorization: "Bearer private-key" } : {},
      payload: { model: "model-test", input: "private-prompt" },
    });
    expect(response.statusCode).toBe(authenticated ? 200 : 401);
    expect(logs.join("")).not.toContain("DEBUG-responses");
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
    expect(upstreamFetch).toHaveBeenCalledTimes(authenticated ? 1 : 0);
  });
});
