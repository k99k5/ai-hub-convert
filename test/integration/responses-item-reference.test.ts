import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { encodeResponsesInputTokensRequest } from "../../src/protocols/openai-responses/input-tokens.js";
import { responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

const input = [
  { type: "message", role: "system", content: [{ type: "input_text", text: "固定提示" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "查询" }] },
];
const output = [
  {
    type: "reasoning",
    id: "rs_private",
    summary: [{ type: "summary_text", text: "分析查询" }],
    encrypted_content: "opaque-private",
  },
  {
    type: "message",
    id: "msg_private",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "准备搜索", annotations: [] }],
  },
  {
    type: "function_call",
    id: "fc_private",
    call_id: "search_1",
    name: "web_search",
    arguments: '{"query":"假期"}',
    status: "completed",
  },
];
const body = { model: "model-test", input };
const response = {
  id: "resp_test",
  object: "response",
  model: "model-test",
  status: "completed",
  output,
  usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
};
const references = output.map(({ id }) => ({ type: "item_reference", id }));
const continuation = [
  ...input,
  ...references,
  {
    type: "function_call_output",
    call_id: "search_1",
    output: [{ type: "input_text", text: "搜索结果" }],
  },
  { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
];

function createApp(logs: string[] = []) {
  const seen: Wire[] = [];
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
      const request = JSON.parse(init?.body as string) as Wire;
      seen.push(request);
      // 模拟完全不支持引用的上游，任何漏传都会让续轮失败。
      if ((request.input as Wire[]).some((item) => item.type === "item_reference")) {
        return Response.json({ error: { message: "不支持引用" } }, { status: 400 });
      }
      return request.stream ? responsesStream(response) : Response.json(response);
    },
  });
  apps.push(app);
  return { app, seen };
}

describe("Responses 内存引用续轮", () => {
  it.each(
    [false, true].flatMap((stream) =>
      [undefined, false, true, null].map((store) => ({ stream, store })),
    ),
  )("展开完整历史并保持顺序与存储选项：%j", async ({ stream, store }) => {
    const logs: string[] = [];
    const { app, seen } = createApp(logs);
    const options = { stream, ...(store === undefined ? {} : { store }) };
    const inject = (payload: Wire) =>
      app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer caller-key" },
        payload,
      });
    expect((await inject({ ...body, ...options })).statusCode).toBe(200);
    const second = await inject({ ...body, ...options, input: continuation });
    expect(second.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ store: store === undefined ? false : store, stream });
    expect(seen[1]?.input).toEqual([
      ...input,
      {
        type: "reasoning",
        id: "rs_private",
        summary: [{ type: "summary_text", text: "分析查询" }],
        encrypted_content: "opaque-private",
      },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "准备搜索" }] },
      {
        type: "function_call",
        call_id: "search_1",
        name: "web_search",
        arguments: '{"query":"假期"}',
      },
      { type: "function_call_output", call_id: "search_1", output: "搜索结果" },
      continuation.at(-1),
    ]);
    expect(seen[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(seen[1]?.prompt_cache_key).toBe(seen[0]?.prompt_cache_key);
    expect(logs.join("")).not.toContain("DEBUG-responses");
    for (const secret of [
      "rs_private",
      "msg_private",
      "fc_private",
      "opaque-private",
      "caller-key",
      "准备搜索",
    ]) {
      expect(logs.join("")).not.toContain(secret);
    }
    if (stream) {
      expect(second.body).toContain('"type":"response.completed"');
      expect(second.body).toContain("data: [DONE]");
    } else expect(second.json().output[1].content[0].text).toBe("准备搜索");
  });

  it.each([false, true])("官方 SDK 回传上一轮输出引用可续轮，stream=%s", async (stream) => {
    const { app, seen } = createApp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("预期 TCP 监听地址");
    const client = new OpenAI({
      apiKey: "key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    });
    const first = await client.responses.create({ model: "model-test", input: "查询" });
    const next: OpenAI.Responses.ResponseInput = first.output.map((item) => {
      if (item.id === undefined) throw new Error("预期输出项具有可引用 ID");
      return { type: "item_reference", id: item.id };
    });
    next.push({ type: "function_call_output", call_id: "search_1", output: "结果" });
    const result = await client.responses.create({ model: "model-test", input: next, stream });
    if (stream && Symbol.asyncIterator in result) {
      let completed = false;
      for await (const event of result) if (event.type === "response.completed") completed = true;
      expect(completed).toBe(true);
    } else expect(result).toMatchObject({ status: "completed" });
    expect(seen).toHaveLength(2);
    expect(JSON.stringify(seen[1]?.input)).not.toContain("item_reference");
  });

  it.each([
    { key: "another-key", model: "model-test", id: "msg_private" },
    { key: "caller-key", model: "another-model", id: "msg_private" },
    { key: "caller-key", model: "model-test", id: "unknown-private" },
  ])("未知、跨凭据或跨模型引用在上游前拒绝：%j", async ({ key, model, id }) => {
    const { app, seen } = createApp();
    await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: body,
    });
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${key}` },
      payload: { model, input: [{ type: "item_reference", id }], stream: true },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toMatchObject({
      type: "invalid_request_error",
      code: "reference_cache_miss",
    });
    expect(result.body).not.toContain(id);
    expect(result.body).not.toContain(key);
    expect(seen).toHaveLength(1);
  });

  it("五分钟到期后不再访问上游，读取不续期", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { app, seen } = createApp();
    const inject = (payload: Wire) =>
      app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer key" },
        payload,
      });
    await inject(body);
    now = 299_999;
    expect((await inject({ ...body, input: references })).statusCode).toBe(200);
    now = 300_000;
    const result = await inject({ ...body, input: references });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.code).toBe("reference_cache_miss");
    expect(seen).toHaveLength(2);
  });

  it.each([undefined, null, 1, "", {}])("非法引用 ID 在访问上游前拒绝：%j", (id) => {
    expect(() =>
      decodeResponsesRequest({ model: "m", input: [{ type: "item_reference", id }] }),
    ).toThrow();
  });

  it("引用不能携带正文，未展开引用不能进入任何上游编码或计数", () => {
    expect(() =>
      decodeResponsesRequest({
        model: "m",
        input: [{ type: "item_reference", id: "item_1", content: "正文" }],
      }),
    ).toThrow();
    const canonical = decodeResponsesRequest({ ...body, input: references });
    expect(() => encodeChatRequest(canonical)).toThrow();
    expect(() => encodeResponsesInputTokensRequest(canonical)).toThrow();
    expect(() =>
      encodeResponsesRequest(canonical, {
        store: false,
        promptCache: { kind: "none" },
        replaySourceExtensions: true,
      }),
    ).toThrow();
  });
});
