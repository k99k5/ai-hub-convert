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
    hint: "item_not_found",
    code: "item_not_found",
  },
  {
    error: { message: "Item private-item does not exist" },
    hint: "item_not_found",
    code: "absent",
  },
  {
    error: { message: "No tool call found for function call output with call_id private-call" },
    hint: "tool_call_not_found",
    code: "absent",
  },
  {
    error: { message: "item_reference is not supported: private-item" },
    hint: "item_reference_unsupported",
    code: "absent",
  },
  {
    error: { code: "private-code", message: "private-message" },
    hint: "unknown",
    code: "unrecognized",
  },
  {
    error: { code: "invalid_value", message: { private: "private-message" } },
    hint: "unknown",
    code: "invalid_value",
  },
];

describe("Responses 上游失败安全诊断", () => {
  it.each(
    [false, true].flatMap((stream) => failures.map((failure) => ({ stream, ...failure }))),
  )("区分上游错误特征且不暴露原始错误：%j", async ({ stream, error, hint, code }) => {
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
        level: "warn",
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
        input: [{ type: "item_reference", id: "private-id" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({
      msg: "[DEBUG-responses-input-v1] Responses 后续处理失败",
      request_id: response.json().request_id,
      stage: "upstream_http",
      upstream_status: 400,
      upstream_code: code,
      reference_hint: hint,
      has_upstream_semantic_event: false,
    });
    expect(logs.join("")).not.toContain("private-");
    expect(response.body).not.toContain("private-");
    expect(response.body).not.toContain("reference_hint");
  });

  it.each([false, true])("非上游 HTTP 错误不标记为上游拒绝，stream=%s", async (stream) => {
    const logs: string[] = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: {
        level: "warn",
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
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({
      stage: "gateway_processing",
      reference_hint: "unknown",
    });
    expect(logs[0]).not.toContain("upstream_status");
    expect(logs[0]).not.toContain("private-");
  });
});
