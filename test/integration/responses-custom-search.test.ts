import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { chatStream, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: ReturnType<typeof buildApp>[] = [];
const sockets: WebSocket[] = [];
const headers = { authorization: "Bearer search-regression-test" };
const online = { type: "custom", name: "web_search", external_web_access: true };
const offline = { ...online, external_web_access: false };
const protocols = ["chat", "responses"] as const;
const transports = ["json", "sse", "ws"] as const;

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe.each(protocols)("custom 搜索离线续轮：%s 上游", (protocol) => {
  it.each(transports)("%s 保留重复声明和离线标记，provider 不被调用", async (transport) => {
    const bodies: Wire[] = [];
    const execute = vi.fn(async () => [
      { title: "不应出现", url: "https://example.test", content: "不应搜索" },
    ]);
    const app = buildApp({
      config: loadConfig({
        UPSTREAM_BASE_URL: "https://upstream.test/v1",
        UPSTREAM_PROTOCOL: protocol,
      }),
      logger: false,
      webSearchProvider: {
        capabilities: () => ({ execute: false, citations: false, streaming: false }),
        execute,
      },
      upstreamFetch: async (_url, init) => {
        const body = JSON.parse(init?.body as string) as Wire;
        bodies.push(body);
        const search = bodies.length % 2 === 1;
        const call = {
          name: INTERNAL_WEB_SEARCH_TOOL_NAME,
          arguments: JSON.stringify({ query: "测试查询" }),
        };
        if (protocol === "chat") {
          const response = {
            id: `chat_${bodies.length}`,
            model: "m",
            created: 1,
            choices: [
              {
                index: 0,
                finish_reason: search ? "tool_calls" : "stop",
                message: search
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [{ type: "function", id: "search", function: call }],
                    }
                  : { role: "assistant", content: "未找到结果" },
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          };
          return body.stream ? chatStream(response) : Response.json(response);
        }
        const response = {
          id: `resp_${bodies.length}`,
          object: "response",
          model: "m",
          status: "completed",
          output: search
            ? [
                {
                  id: "fc_search",
                  type: "function_call",
                  status: "completed",
                  call_id: "search",
                  ...call,
                },
              ]
            : [
                {
                  id: `msg_${bodies.length}`,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "未找到结果", annotations: [] }],
                },
              ],
          usage: { input_tokens: 3, output_tokens: 2 },
        };
        return body.stream ? responsesStream(response) : Response.json(response);
      },
    });
    apps.push(app);
    let socket: WebSocket | undefined;
    if (transport === "ws") {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      socket = new WebSocket(`${address.replace("http:", "ws:")}/v1/responses`, { headers });
      sockets.push(socket);
      await once(socket, "open");
    }
    const send = async (payload: Wire): Promise<Wire> => {
      if (socket) {
        const peer = socket;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            peer.off("message", receive);
            reject(new Error("等待搜索终态超时"));
          }, 3000);
          const receive = (raw: Buffer) => {
            const event = JSON.parse(raw.toString()) as Wire;
            if (event.type !== "response.completed" && event.type !== "error") return;
            clearTimeout(timer);
            peer.off("message", receive);
            if (event.type === "error") reject(new Error(JSON.stringify(event)));
            else resolve(event.response as Wire);
          };
          peer.on("message", receive);
          peer.send(JSON.stringify({ type: "response.create", ...payload }));
        });
      }
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers,
        payload: { ...payload, stream: transport === "sse" },
      });
      expect(response.statusCode, response.body).toBe(200);
      if (transport === "json") return response.json<Wire>();
      const events = response.body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)) as Wire);
      const completed = events.find((event) => event.type === "response.completed");
      expect(completed, response.body).toBeDefined();
      return completed?.response as Wire;
    };
    let previous: unknown;
    for (let turn = 0; turn < 2; turn++) {
      const response = await send({
        model: "m",
        tools: [online],
        tool_choice: { type: "custom", name: "web_search" },
        include: ["web_search_call.action.sources"],
        ...(previous === undefined ? {} : { previous_response_id: previous }),
        input: [
          { type: "additional_tools", role: "developer", tools: [offline] },
          { role: "user", content: "搜索" },
        ],
      });
      expect(response.status).toBe("completed");
      expect(response.output).toMatchObject([
        { type: "web_search_call", status: "completed", action: { sources: [] } },
        { type: "message", content: [{ annotations: [] }] },
      ]);
      expect(response.usage).toMatchObject({ input_tokens: 6, output_tokens: 4 });
      previous = response.id;
    }
    expect(bodies).toHaveLength(4);
    expect(execute).not.toHaveBeenCalled();
    for (const body of [bodies[1], bodies[3]]) {
      const history = (protocol === "chat" ? body?.messages : body?.input) as Wire[];
      const result = history.find((item) =>
        protocol === "chat" ? item.role === "tool" : item.type === "function_call_output",
      );
      expect(
        JSON.parse((protocol === "chat" ? result?.content : result?.output) as string),
      ).toMatchObject({ result_count: 0, results: [] });
    }
  });
});
