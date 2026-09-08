import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { responsesFrames, responsesStream } from "../helpers/upstream.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
const authorization = { authorization: "Bearer reference-limit-key" };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function outputResponse(text = "缓存边界测试", status = "completed") {
  return {
    id: "resp_cache_limit",
    object: "response",
    model: "model-test",
    status,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [
      {
        id: "msg_cache_limit",
        type: "message",
        role: "assistant",
        status,
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

function appWith(upstreamFetch: typeof globalThis.fetch, environment: NodeJS.ProcessEnv = {}) {
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1", ...environment }),
    logger: false,
    upstreamFetch,
  });
  apps.push(app);
  return app;
}

async function ask(app: ReturnType<typeof buildApp>, stream = false) {
  return app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: authorization,
    payload: { model: "model-test", input: "回答", stream },
  });
}

async function reference(app: ReturnType<typeof buildApp>, stream = false) {
  return app.inject({
    method: "POST",
    url: "/v1/responses",
    headers: authorization,
    payload: {
      model: "model-test",
      input: [{ type: "item_reference", id: "msg_cache_limit" }],
      stream,
    },
  });
}

describe("Responses 引用缓存的应用边界", () => {
  it.each([false, true])("未完成的响应正常返回但不缓存，stream=%s", async (stream) => {
    const upstreamFetch = vi.fn(async () => {
      const response = outputResponse("尚未完成", "incomplete");
      return stream ? responsesStream(response) : Response.json(response);
    });
    const app = appWith(upstreamFetch);
    const response = await ask(app, stream);
    expect(response.statusCode).toBe(200);
    if (stream) {
      expect(response.body).toContain("event: response.incomplete");
      expect(response.body).toContain("data: [DONE]");
    } else expect(response.json()).toMatchObject({ status: "incomplete" });
    const followup = await reference(app, stream);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error.code).toBe("reference_cache_miss");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["缺失终态", "终态前畸形数据", "终态后畸形数据"])("%s 不写入缓存", async (failure) => {
    const frames = responsesFrames(outputResponse());
    const malformed = "event: response.output_text.delta\ndata: {invalid-json\n\n";
    const broken =
      failure === "缺失终态"
        ? frames.slice(0, -2).join("")
        : failure === "终态前畸形数据"
          ? [...frames.slice(0, -2), malformed].join("")
          : [...frames.slice(0, -1), malformed, "data: [DONE]\n\n"].join("");
    const upstreamFetch = vi.fn(
      async () => new Response(broken, { headers: { "content-type": "text/event-stream" } }),
    );
    const app = appWith(upstreamFetch);
    const response = await ask(app, true);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("event: response.completed");
    expect(response.body).not.toContain("data: [DONE]");
    const followup = await reference(app);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error.code).toBe("reference_cache_miss");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "response.failed",
    "response.cancelled",
    "error",
  ])("明确失败终态 %s 仅发送一次清洗错误，不缓存或发送 DONE", async (type) => {
    const frames = responsesFrames(outputResponse()).slice(0, -2);
    frames.push(
      `event: ${type}\ndata: ${JSON.stringify({
        type,
        error: { message: "private-upstream-error" },
        response: { error: { message: "private-upstream-error" } },
      })}\n\n`,
    );
    const upstreamFetch = vi.fn(
      async () =>
        new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }),
    );
    const app = appWith(upstreamFetch);
    const result = await ask(app, true);
    expect(result.statusCode).toBe(200);
    expect(result.body.match(/event: error\n/g)).toHaveLength(1);
    expect(result.body).not.toContain("private-upstream-error");
    expect(result.body).not.toContain("data: [DONE]");
    expect(result.body).not.toContain("event: response.completed");
    const followup = await reference(app);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error.code).toBe("reference_cache_miss");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("单个输出项超过一 MiB 仍正常返回但不缓存，stream=%s", async (stream) => {
    const text = "x".repeat(1024 * 1024 + 1);
    const upstreamFetch = vi.fn(async () => {
      const response = outputResponse(text);
      return stream ? responsesStream(response) : Response.json(response);
    });
    const app = appWith(upstreamFetch);
    const response = await ask(app, stream);
    expect(response.statusCode).toBe(200);
    if (stream) {
      expect(response.body).toContain(text);
      expect(response.body).toContain("event: response.completed");
      expect(response.body).toContain("data: [DONE]");
    } else {
      expect(response.json().status).toBe("completed");
      expect(response.json().output[0].content[0].text).toBe(text);
    }
    const followup = await reference(app, stream);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error.code).toBe("reference_cache_miss");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    false,
    true,
  ])("引用展开超过请求体限制时在调用上游前返回 400，stream=%s", async (stream) => {
    const upstreamFetch = vi.fn(async () => Response.json(outputResponse("x".repeat(2_000))));
    const app = appWith(upstreamFetch, { BODY_LIMIT_BYTES: "1024" });
    expect((await ask(app)).statusCode).toBe(200);
    const followup = await reference(app, stream);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error).toMatchObject({
      code: "invalid_request",
      type: "invalid_request_error",
    });
    expect(followup.json().error.message).toContain("展开引用后的请求超过");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("关闭应用后新实例不能读取先前实例的缓存", async () => {
    const firstFetch = vi.fn(async () => Response.json(outputResponse()));
    const first = appWith(firstFetch);
    expect((await ask(first)).statusCode).toBe(200);
    expect((await reference(first)).statusCode).toBe(200);
    expect(firstFetch).toHaveBeenCalledTimes(2);
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const secondFetch = vi.fn(async () => Response.json(outputResponse()));
    const second = appWith(secondFetch);
    const followup = await reference(second);
    expect(followup.statusCode).toBe(400);
    expect(followup.json().error.code).toBe("reference_cache_miss");
    expect(secondFetch).not.toHaveBeenCalled();
    expect((await ask(second)).statusCode).toBe(200);
    expect((await reference(second)).statusCode).toBe(200);
    expect(secondFetch).toHaveBeenCalledTimes(2);
  });
});
