import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

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
  return { app, logs, upstreamFetch };
}

describe("Responses 测试分支输入诊断", () => {
  it.each([
    { item: { type: "item_reference", id: "private-id" }, path: "input[1]", tag: "item_reference" },
    {
      item: {
        type: "function_call_output",
        call_id: "private-call",
        output: { secret: "private-output" },
      },
      path: "input[1]",
      tag: "function_call_output",
    },
    {
      item: {
        type: "reasoning",
        id: "private-id",
        summary: [{ type: "reasoning_text", text: "private-reasoning" }],
      },
      path: "input[1].summary[0]",
      tag: "reasoning_text",
    },
    {
      item: { role: "user", content: [{ type: "input_file", file_id: "private-file" }] },
      path: "input[1].content[0]",
      tag: "input_file",
    },
    {
      item: {
        type: "function_call_output",
        call_id: "private-call",
        output: [{ type: "input_image", image_url: "private-image" }],
      },
      path: "input[1].output[0]",
      tag: "input_image",
    },
  ])("准确定位拒绝路径 $path 与类型 $tag", async ({ item, path, tag }) => {
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
    expect(body).not.toHaveProperty("diagnostic_path");
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({
      request_id: body.request_id,
      msg: "[DEBUG-responses-input-v1] Responses 输入校验失败",
      stage: "request_decode",
      code: "INVALID_OPENAI_RESPONSES_REQUEST",
      diagnostic_path: path,
      input_kind: "array",
      input_count: 2,
      rejected_shape: { kind: "object", fields: { type: tag } },
    });
    expect(logs.join("")).not.toContain("private-");
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("长历史末尾的非法内容也能直接定位，未知键名和枚举值不进入日志", async () => {
    const { app, logs } = setup();
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
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({
      diagnostic_path: "input[100].content[100]",
      rejected_shape: {
        fields: { type: { kind: "string" }, text: { kind: "string", length: 120000 } },
        unknown_field_count: 1,
      },
    });
    expect(logs.join("")).not.toContain("private-");
    expect(logs.join("").length).toBeLessThan(2000);
  });

  it("顶层校验失败记录结构，未知字段名称不进入日志", async () => {
    const { app, logs } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer private-key" },
      payload: { model: "model-test", input: "private-prompt", "private-field": "private-value" },
    });
    expect(response.statusCode).toBe(400);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "")).toMatchObject({
      diagnostic_path: "request",
      input_kind: "string",
      rejected_shape: { unknown_field_count: 1 },
    });
    expect(logs.join("")).not.toContain("private-");
  });

  it.each([
    true,
    false,
  ])("合法请求和鉴权失败不产生输入拒绝诊断，authenticated=%s", async (authenticated) => {
    const { app, logs, upstreamFetch } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: authenticated ? { authorization: "Bearer private-key" } : {},
      payload: { model: "model-test", input: "private-prompt" },
    });
    expect(response.statusCode).toBe(authenticated ? 200 : 401);
    expect(logs).toEqual([]);
    expect(upstreamFetch).toHaveBeenCalledTimes(authenticated ? 1 : 0);
  });
});
