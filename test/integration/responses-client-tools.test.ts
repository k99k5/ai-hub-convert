import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";
import { responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Responses 客户端搜索工具续轮", () => {
  it.each([false, true])("官方 SDK 回传文本数组后继续生成，stream=%s", async (stream) => {
    const bodies: Wire[] = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      upstreamFetch: async (_input, init) => {
        bodies.push(JSON.parse(init?.body as string) as Wire);
        const response = {
          id: `resp_${bodies.length}`,
          object: "response",
          model: "model-test",
          status: "completed",
          output:
            bodies.length === 1
              ? [
                  {
                    type: "function_call",
                    id: "fc_search",
                    call_id: "search_1",
                    name: "web_search",
                    arguments: '{"query":"假期"}',
                    status: "completed",
                  },
                ]
              : [
                  {
                    type: "message",
                    id: "msg_answer",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "假期安排", annotations: [] }],
                  },
                ],
          usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
        };
        return bodies.at(-1)?.stream ? responsesStream(response) : Response.json(response);
      },
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("预期 TCP 监听地址");
    const client = new OpenAI({
      apiKey: "caller-key",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 0,
    });
    const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: "查询假期" }];
    const tools: OpenAI.Responses.Tool[] = [
      {
        type: "function",
        name: "web_search",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        strict: false,
      },
    ];
    const first = await client.responses.create({ model: "model-test", input, tools });
    expect(first.output).toHaveLength(1);
    expect(first.output[0]).toMatchObject({ type: "function_call", call_id: "search_1" });
    const call = first.output[0];
    if (call?.type !== "function_call") throw new Error("预期客户端搜索函数调用");
    input.push(call, {
      type: "function_call_output",
      call_id: "search_1",
      output: [
        { type: "input_text", text: "搜索结果一\n" },
        { type: "input_text", text: "搜索结果二" },
      ],
    });
    const request = { model: "model-test", input, tools };
    if (stream) {
      const events = await client.responses.create({ ...request, stream: true });
      let text = "";
      let completed = false;
      for await (const event of events) {
        if (event.type === "response.output_text.delta") text += event.delta;
        if (event.type === "response.completed") {
          completed = true;
          expect(event.response.usage?.total_tokens).toBe(15);
        }
      }
      expect(text).toBe("假期安排");
      expect(completed).toBe(true);
    } else {
      const result = await client.responses.create(request);
      expect(result.output_text).toBe("假期安排");
      expect(result.usage?.total_tokens).toBe(15);
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.input).toContainEqual({
      type: "function_call_output",
      call_id: "search_1",
      output: "搜索结果一\n搜索结果二",
    });
    expect(bodies[0]?.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1]?.prompt_cache_key).toBe(bodies[0]?.prompt_cache_key);
  });
});
