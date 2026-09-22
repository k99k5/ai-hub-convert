import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { chatStream, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Protocol = "chat" | "responses";
const apps: ReturnType<typeof buildApp>[] = [];
const sockets: WebSocket[] = [];
const headers = { authorization: "Bearer local-search-test" };
const search = {
  type: "tool_search",
  execution: "client",
  description: "Find tools by query",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const discovered = [
  {
    type: "namespace",
    name: "functions",
    tools: [
      {
        type: "function",
        name: "lookup",
        defer_loading: true,
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
        },
      },
      { type: "custom", name: "exec", defer_loading: true, format: { type: "text" } },
    ],
  },
];
const searchResult = {
  type: "tool_search_output",
  call_id: "call_search",
  execution: "client",
  tools: discovered,
};
const toolResults = [
  { type: "function_call_output", call_id: "call_lookup", output: "found" },
  { type: "custom_tool_call_output", call_id: "call_exec", output: "executed" },
];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a request or response");
  return value;
}

function definitions(body: Wire, protocol: Protocol): Wire[] {
  return (body.tools as Wire[]).map((tool) =>
    protocol === "chat" ? (tool.function as Wire) : tool,
  );
}

function setup(protocol: Protocol, malformed = false) {
  const bodies: Wire[] = [];
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: protocol,
    }),
    logger: false,
    upstreamFetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Wire;
      bodies.push(body);
      const tools = definitions(body, protocol);
      const calls =
        bodies.length === 1
          ? [
              {
                call_id: "call_search",
                name: present(tools[0]).name,
                arguments: malformed ? "[]" : '{"query":"lookup and exec"}',
              },
            ]
          : bodies.length === 2
            ? [
                {
                  call_id: "call_lookup",
                  name: present(tools[1]).name,
                  arguments: '{"key":"value"}',
                },
                {
                  call_id: "call_exec",
                  name: present(tools[2]).name,
                  arguments: '{"input":"raw command 😀"}',
                },
              ]
            : [];
      if (protocol === "chat") {
        const response = {
          id: `chat_${bodies.length}`,
          model: "codex-test",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: calls.length ? "tool_calls" : "stop",
              message: calls.length
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: calls.map((call) => ({
                      type: "function",
                      id: call.call_id,
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : { role: "assistant", content: "SEARCH_OK" },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
        return body.stream ? chatStream(response) : Response.json(response);
      }
      const response = {
        id: `resp_${bodies.length}`,
        object: "response",
        model: "codex-test",
        status: "completed",
        output: calls.length
          ? calls.map((call) => ({
              type: "function_call",
              id: `fc_${call.call_id}`,
              status: "completed",
              ...call,
            }))
          : [
              {
                type: "message",
                id: "msg_final",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "SEARCH_OK", annotations: [] }],
              },
            ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };
      return body.stream ? responsesStream(response) : Response.json(response);
    },
  });
  apps.push(app);
  return { app, bodies };
}

function sse(body: string): Wire[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Wire);
}

function validateSearch(response: Wire, events: Wire[] = []) {
  expect(response.output).toMatchObject([
    {
      type: "tool_search_call",
      execution: "client",
      call_id: "call_search",
      arguments: { query: "lookup and exec" },
      status: "completed",
    },
  ]);
  expect((response.output as Wire[])[0]).not.toHaveProperty("name");
  expect(
    events.some((event) => String(event.type).startsWith("response.function_call_arguments")),
  ).toBe(false);
  expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, i) => i));
}

function validateLoaded(response: Wire) {
  expect(response.output).toMatchObject([
    {
      type: "function_call",
      namespace: "functions",
      name: "lookup",
      call_id: "call_lookup",
      arguments: '{"key":"value"}',
    },
    {
      type: "custom_tool_call",
      namespace: "functions",
      name: "exec",
      call_id: "call_exec",
      input: "raw command 😀",
    },
  ]);
}

function validateUpstream(bodies: Wire[], protocol: Protocol) {
  const second = present(bodies[1]);
  const third = present(bodies[2]);
  const tools = definitions(second, protocol);
  expect(tools).toHaveLength(3);
  expect(definitions(third, protocol)).toEqual(tools);
  const input = (protocol === "chat" ? second.messages : second.input) as Wire[];
  const result = present(
    input.find((item) =>
      protocol === "chat"
        ? item.role === "tool" && item.tool_call_id === "call_search"
        : item.type === "function_call_output" && item.call_id === "call_search",
    ),
  );
  const portable = JSON.parse((protocol === "chat" ? result.content : result.output) as string);
  expect(portable.tools.map((tool: Wire) => tool.name)).toEqual(
    tools.slice(1).map((tool) => tool.name),
  );
  const history = JSON.stringify(protocol === "chat" ? third.messages : third.input);
  expect(history).not.toContain('"tool_search_call"');
  expect(history).not.toContain('"tool_search_output"');
  expect(history).toContain("found");
  expect(history).toContain("executed");
  expect(third).not.toHaveProperty("previous_response_id");
}

describe.each<Protocol>([
  "chat",
  "responses",
])("Codex client tool search via %s upstream", (protocol) => {
  it.each([
    [false, "full"],
    [true, "full"],
    [false, "previous"],
    [true, "previous"],
    [true, "reference"],
    [true, "conversation"],
  ] as const)("discovers and executes tools across three turns (stream=%s, history=%s)", async (stream, history) => {
    const { app, bodies } = setup(protocol);
    let conversation: string | undefined;
    if (history === "conversation") {
      const created = await app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers,
        payload: {},
      });
      conversation = created.json().id;
    }
    const send = async (body: Wire) => {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers,
        payload: { model: "codex-test", tools: [search], stream, ...body },
      });
      expect(response.statusCode, response.body).toBe(200);
      const events = stream ? sse(response.body) : [];
      const completed = stream
        ? (present(events.find((event) => event.type === "response.completed")).response as Wire)
        : response.json();
      return { completed, events };
    };
    let input: unknown[] = [{ role: "user", content: "Find and use tools" }];
    const first = await send({ input, ...(conversation ? { conversation } : {}) });
    validateSearch(first.completed, first.events);
    const continuation = (response: Wire, results: Wire[]): Wire => {
      if (history === "previous") return { previous_response_id: response.id, input: results };
      if (conversation) return { conversation, input: results };
      const output = response.output as Wire[];
      input = [
        ...input,
        ...output.map((item) =>
          history === "reference" ? { type: "item_reference", id: item.id } : item,
        ),
        ...results,
      ];
      return { input };
    };
    const second = await send(continuation(first.completed, [searchResult]));
    validateLoaded(second.completed);
    const third = await send(continuation(second.completed, toolResults));
    expect(third.completed.output).toMatchObject([{ content: [{ text: "SEARCH_OK" }] }]);
    validateUpstream(bodies, protocol);
    if (conversation) {
      const stored = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversation}/items`,
        headers,
      });
      expect(stored.json().data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool_search_call",
            arguments: { query: "lookup and exec" },
          }),
          expect.objectContaining({ type: "tool_search_output", call_id: "call_search" }),
        ]),
      );
    }
  });

  it("round-trips native search and discovered tool calls over WebSocket", async () => {
    const { app, bodies } = setup(protocol);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`${address.replace("http:", "ws:")}/v1/responses`, { headers });
    sockets.push(socket);
    await once(socket, "open");
    const turn = (body: Wire) =>
      new Promise<Wire[]>((resolve, reject) => {
        const events: Wire[] = [];
        const onMessage = (data: Buffer) => {
          const event = JSON.parse(data.toString()) as Wire;
          events.push(event);
          if (event.type === "error" || event.type === "response.completed") {
            socket.off("message", onMessage);
            if (event.type === "error") reject(new Error(JSON.stringify(event)));
            else resolve(events);
          }
        };
        socket.on("message", onMessage);
        socket.send(
          JSON.stringify({
            type: "response.create",
            model: "codex-test",
            tools: [search],
            ...body,
          }),
        );
      });
    const first = await turn({ input: "Find tools" });
    const response = present(first.at(-1)).response as Wire;
    validateSearch(response, first);
    const second = await turn({ previous_response_id: response.id, input: [searchResult] });
    const loaded = present(second.at(-1)).response as Wire;
    validateLoaded(loaded);
    await turn({ previous_response_id: loaded.id, input: toolResults });
    validateUpstream(bodies, protocol);
  });

  it.each([
    false,
    true,
  ])("fails malformed upstream search calls without emitting a completed call (stream=%s)", async (stream) => {
    const { app } = setup(protocol, true);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", stream, input: "Find tools", tools: [search] },
    });
    // A malformed first Chat chunk can fail before SSE headers are sent.
    if (response.statusCode !== 200) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toHaveProperty("error");
    } else {
      expect(stream).toBe(true);
      const events = sse(response.body);
      expect(events.some((event) => event.type === "response.output_item.done")).toBe(false);
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(events.at(-1)?.type).toBe("error");
    }
  });
});
