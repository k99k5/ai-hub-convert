import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: ReturnType<typeof buildApp>[] = [];
const headers = { authorization: "Bearer test-key" };
const base = {
  id: "resp_gap",
  model: "model-test",
  object: "response",
  status: "completed",
  usage: { input_tokens: 3, output_tokens: 2 },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(output: Wire) {
  const requests: Wire[] = [];
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async (_input, init) => {
      const body = JSON.parse(init?.body as string) as Wire;
      requests.push(body);
      return body.stream ? responsesStream(output) : Response.json(output);
    },
  });
  apps.push(app);
  return { app, requests };
}

function frames(body: string): Wire[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Wire);
}

const incompleteCall = {
  ...base,
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [
    {
      type: "function_call",
      id: "fc_gap",
      call_id: "call_gap",
      name: "f",
      arguments: '{"x":',
      status: "incomplete",
    },
  ],
};

describe("流式协议缺口 HTTP 回归", () => {
  it("Responses 保留截断工具参数并返回未完成终态", async () => {
    const { app, requests } = setup(incompleteCall);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "model-test", input: "调用工具", stream: true },
    });
    expect(response.statusCode).toBe(200);
    const events = frames(response.body);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "response.incomplete")?.response).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", arguments: '{"x":', status: "incomplete" }],
    });
    expect(response.body).toContain("data: [DONE]");
    expect(requests).toHaveLength(1);
  });

  it("Anthropic 同样的截断参数仍按工具对象契约拒绝", async () => {
    const { app, requests } = setup(incompleteCall);
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers,
      payload: {
        model: "model-test",
        max_tokens: 64,
        messages: [{ role: "user", content: "调用工具" }],
        stream: true,
      },
    });
    expect(response.body).toContain('"type":"error"');
    expect(response.body).not.toContain("event: message_stop");
    expect(requests).toHaveLength(1);
  });

  it("Responses 已完成工具调用仍拒绝非法 JSON", async () => {
    const { app } = setup({
      ...base,
      output: [{ ...incompleteCall.output[0], status: "completed" }],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "model-test", input: "调用工具", stream: true },
    });
    expect(response.body).toContain('"type":"error"');
    expect(response.body).not.toContain("data: [DONE]");
  });

  it.each([false, true])("保留未完成文本项状态，流式=%s", async (stream) => {
    const output = [
      {
        type: "message",
        id: "msg_gap",
        role: "assistant",
        status: "incomplete",
        content: [{ type: "output_text", text: "尚未完成", annotations: [] }],
      },
    ];
    const { app } = setup({
      ...base,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "model-test", input: "回答", stream },
    });
    expect(response.statusCode).toBe(200);
    const result = stream
      ? frames(response.body).find((event) => event.type === "response.incomplete")?.response
      : response.json();
    expect(result).toMatchObject({ status: "incomplete", output: [{ status: "incomplete" }] });
  });

  it.each(["/v1/responses", "/v1/messages"])("第二文本块引用可通过 %s 流式入口", async (url) => {
    const { app } = setup({
      ...base,
      output: [
        {
          type: "message",
          id: "msg_gap",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "前缀\n", annotations: [] },
            {
              type: "output_text",
              text: "第二段引用",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/doc",
                  title: "资料",
                  start_index: 0,
                  end_index: 3,
                },
              ],
            },
          ],
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload:
        url === "/v1/responses"
          ? { model: "model-test", input: "回答", stream: true }
          : {
              model: "model-test",
              max_tokens: 64,
              messages: [{ role: "user", content: "回答" }],
              stream: true,
            },
    });
    expect(response.statusCode).toBe(200);
    const events = frames(response.body);
    expect(events.some((event) => event.type === "error")).toBe(false);
    if (url === "/v1/responses") {
      expect(
        events.find((event) => event.type === "response.output_text.annotation.added")?.annotation,
      ).toMatchObject({ start_index: 3, end_index: 6, url: "https://example.test/doc" });
      expect(events.some((event) => event.type === "response.completed")).toBe(true);
    } else {
      expect(
        events.find((event) => (event.delta as Wire)?.type === "citations_delta")?.delta,
      ).toMatchObject({ citation: { cited_text: "第二段", url: "https://example.test/doc" } });
      expect(events.some((event) => event.type === "message_stop")).toBe(true);
    }
  });

  it("官方 SDK 通过网关解析结构化输出", async () => {
    const { app, requests } = setup({
      ...base,
      output: [
        {
          type: "message",
          id: "msg_gap",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: '{"answer":"已处理"}', annotations: [] }],
        },
      ],
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("预期本地 TCP 地址");
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    });
    const text = {
      format: {
        type: "json_schema" as const,
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    };
    const response = await client.responses.parse({
      model: "model-test",
      input: "返回 JSON",
      text,
    });
    expect(response.output_parsed).toEqual({ answer: "已处理" });
    expect(requests[0]?.text).toEqual(text);
  });
});
