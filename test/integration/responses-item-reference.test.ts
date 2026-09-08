import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { encodeResponsesInputTokensRequest } from "../../src/protocols/openai-responses/input-tokens.js";
import { responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const input = [
  { type: "message", role: "system", content: [{ type: "input_text", text: "固定提示" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "查询" }] },
  { type: "item_reference", id: "rs_upstream_1" },
  { type: "function_call", call_id: "search_1", name: "search", arguments: "{}" },
  { type: "function_call_output", call_id: "search_1", output: "结果" },
  { type: "item_reference", id: "msg_upstream_2" },
  { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
];
const body = { model: "model-test", input };

describe("Responses 同协议引用透传", () => {
  it.each(
    [false, true].flatMap((stream) =>
      [undefined, false, true, null].map((store) => ({ stream, store })),
    ),
  )("保留七项历史的 ID、顺序和存储选项：%j", async ({ stream, store }) => {
    const seen: Wire[] = [];
    const logs: string[] = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: {
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
      upstreamFetch: async (url, init) => {
        expect(String(url)).toBe("https://upstream.test/v1/responses");
        seen.push(JSON.parse(init?.body as string) as Wire);
        const response = {
          id: "resp_test",
          object: "response",
          model: "model-test",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_answer",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "上游解析了引用", annotations: [] }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        };
        return stream ? responsesStream(response) : Response.json(response);
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { ...body, stream, ...(store === undefined ? {} : { store }) },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ input, store: store === undefined ? false : store, stream });
    expect(seen[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    const diagnostics = logs
      .map((line) => JSON.parse(line) as Wire)
      .filter((line) => line.event === "item_reference_accepted");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      reference_count: 2,
      store: store === undefined ? false : store,
    });
    expect(logs.join("")).not.toContain("rs_upstream_1");
    expect(logs.join("")).not.toContain("msg_upstream_2");
    expect(logs.join("")).not.toContain("caller-key");
    if (stream) {
      expect(response.body).toContain('"type":"response.completed"');
      expect(response.body).toContain("data: [DONE]");
    } else expect(response.json().output[0].content[0].text).toBe("上游解析了引用");
  });

  it.each([
    false,
    true,
  ])("上游找不到引用时返回清洗后的错误，不回退重试，stream=%s", async (stream) => {
    const upstreamFetch = vi.fn(async () =>
      Response.json(
        { error: { message: "private-upstream-item-secret", code: "item_not_found" } },
        { status: 400 },
      ),
    );
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      upstreamFetch,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { ...body, stream },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ type: "invalid_request_error" });
    expect(response.body).not.toContain("private-upstream-item-secret");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 1, "", {}])("非法引用 ID 在访问上游前拒绝：%j", (id) => {
    expect(() =>
      decodeResponsesRequest({ model: "m", input: [{ type: "item_reference", id }] }),
    ).toThrow();
  });

  it("拒绝引用项携带正文，避免静默丢失内容", () => {
    expect(() =>
      decodeResponsesRequest({
        model: "m",
        input: [{ type: "item_reference", id: "item_1", content: "正文" }],
      }),
    ).toThrow();
  });

  it("禁止跨协议、关闭扩展回放或计数时静默丢弃引用", () => {
    const canonical = decodeResponsesRequest(body);
    expect(() => encodeChatRequest(canonical)).toThrow();
    expect(() => encodeResponsesInputTokensRequest(canonical)).toThrow();
    expect(() =>
      encodeResponsesRequest(canonical, { store: false, promptCache: { kind: "none" } }),
    ).toThrow();
    expect(() =>
      encodeResponsesRequest(
        { ...canonical, source: "anthropic" },
        { store: false, promptCache: { kind: "none" }, replaySourceExtensions: true },
      ),
    ).toThrow();
  });

  it("引用 ID 的变化不影响稳定前缀缓存键", () => {
    const canonical = decodeResponsesRequest(body);
    const options = {
      store: false,
      replaySourceExtensions: true,
      promptCache: { kind: "prompt-cache-key" as const },
    };
    const first = encodeResponsesRequest(canonical, options);
    const reference = canonical.messages[2]?.itemReference;
    if (!reference) throw new Error("缺少引用项");
    reference.id = "rs_another";
    expect(encodeResponsesRequest(canonical, options).prompt_cache_key).toBe(
      first.prompt_cache_key,
    );
  });

  it("引用容器不能混入正文后被编码器静默丢弃", () => {
    const canonical = decodeResponsesRequest(body);
    canonical.messages[2]?.content.push({ type: "text", text: "正文" });
    expect(() =>
      encodeResponsesRequest(canonical, {
        store: false,
        replaySourceExtensions: true,
        promptCache: { kind: "none" },
      }),
    ).toThrow();
  });
});
