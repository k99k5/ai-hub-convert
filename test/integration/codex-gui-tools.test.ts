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
const headers = { authorization: "Bearer codex-test-key" };
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a request or response");
  return value;
}
const rawInput = 'text("hello 😀");\n// a backslash: \\';
const tools = [
  {
    type: "namespace",
    name: "functions",
    description: "Client tools",
    tools: [
      {
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        type: "custom",
        name: "exec",
        description: "Execute text",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ],
  },
];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

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
      const first = bodies.length === 1;
      const definitions = (body.tools as Wire[]).map((tool) =>
        protocol === "chat" ? (tool.function as Wire) : tool,
      );
      const calls = first
        ? definitions.map((tool, index) => ({
            call_id: `call_${index}`,
            name: tool.name,
            arguments:
              index === 0
                ? '{"query":"value"}'
                : malformed
                  ? '{"input":42}'
                  : JSON.stringify({ input: rawInput }),
          }))
        : [];
      if (protocol === "chat") {
        const response = {
          id: `chat_${bodies.length}`,
          model: "codex-test",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: first ? "tool_calls" : "stop",
              message: first
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: calls.map((call) => ({
                      id: call.call_id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : { role: "assistant", content: "OK" },
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
        output: first
          ? calls.map((call, index) => ({
              type: "function_call",
              id: `fc_${index}`,
              status: "completed",
              ...call,
            }))
          : [
              {
                type: "message",
                id: "msg_answer",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "OK", annotations: [] }],
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

function initial(additional: boolean): Wire {
  return additional
    ? {
        input: [
          { type: "additional_tools", id: "tools_1", role: "developer", tools },
          { type: "message", role: "user", content: "Use both tools" },
        ],
      }
    : { input: "Use both tools", tools };
}

function sse(body: string): Wire[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Wire);
}

function validateOutput(response: Wire) {
  expect(response.status).toBe("completed");
  expect(response.output).toMatchObject([
    {
      type: "function_call",
      namespace: "functions",
      name: "lookup",
      call_id: "call_0",
      arguments: '{"query":"value"}',
    },
    {
      type: "custom_tool_call",
      namespace: "functions",
      name: "exec",
      call_id: "call_1",
      input: rawInput,
    },
  ]);
  expect((response.output as Wire[])[1]).not.toHaveProperty("arguments");
}

const results = [
  { type: "function_call_output", call_id: "call_0", output: "found" },
  {
    type: "custom_tool_call_output",
    call_id: "call_1",
    output: [{ type: "input_text", text: "done" }],
  },
];

function validateHistory(protocol: Protocol, body: Wire) {
  expect(body).not.toHaveProperty("previous_response_id");
  expect(body.tools).toHaveLength(2);
  const text = JSON.stringify(protocol === "chat" ? body.messages : body.input);
  expect(text).not.toContain('"additional_tools"');
  expect(text).not.toContain('"custom_tool_call"');
  expect(text).toContain("found");
  expect(text).toContain("done");
  const input = protocol === "chat" ? (body.messages as Wire[]) : (body.input as Wire[]);
  const calls =
    protocol === "chat"
      ? (present(input.find((item) => item.role === "assistant")).tool_calls as Wire[]).map(
          (call) => call.function as Wire,
        )
      : input.filter((item) => item.type === "function_call");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(present(calls[1]).arguments as string)).toEqual({ input: rawInput });
  const definitions = (body.tools as Wire[]).map((tool) =>
    protocol === "chat" ? (tool.function as Wire) : tool,
  );
  expect(calls.map((call) => call.name)).toEqual(definitions.map((tool) => tool.name));
}

describe.each<Protocol>(["chat", "responses"])("Codex GUI tools via %s upstream", (protocol) => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("round-trips native tools and previous_response_id (stream=%s, additional=%s)", async (stream, additional) => {
    const { app, bodies } = setup(protocol);
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", stream, ...initial(additional) },
    });
    expect(first.statusCode).toBe(200);
    const events = stream ? sse(first.body) : [];
    const response = stream
      ? (present(events.find((event) => event.type === "response.completed")).response as Wire)
      : first.json();
    validateOutput(response);
    if (stream) {
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
      expect(
        events.find((event) => event.type === "response.custom_tool_call_input.done"),
      ).toHaveProperty("input", rawInput);
      expect(
        events.filter((event) => event.type === "response.function_call_arguments.done"),
      ).toHaveLength(1);
    }
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "codex-test",
        previous_response_id: response.id,
        input: results,
        ...(additional ? {} : { tools }),
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().output[0].content[0].text).toBe("OK");
    validateHistory(protocol, present(bodies[1]));
  });

  it("replays native custom output through item_reference", async () => {
    const { app, bodies } = setup(protocol);
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", ...initial(false) },
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: {
        model: "codex-test",
        tools,
        input: [
          ...first.json().output.map((item: Wire) => ({ type: "item_reference", id: item.id })),
          ...results,
        ],
      },
    });
    expect(second.statusCode).toBe(200);
    validateHistory(protocol, present(bodies[1]));
  });

  it("preserves additional tools and native outputs in Conversations", async () => {
    const { app, bodies } = setup(protocol);
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers,
      payload: {},
    });
    const conversation = created.json().id;
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", conversation, ...initial(true) },
    });
    expect(first.statusCode).toBe(200);
    validateOutput(first.json());
    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", conversation, input: results },
    });
    expect(second.statusCode).toBe(200);
    validateHistory(protocol, present(bodies[1]));
    const stored = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversation}/items`,
      headers,
    });
    expect(
      stored
        .json()
        .data.some((item: Wire) => item.type === "custom_tool_call" && item.input === rawInput),
    ).toBe(true);
  });

  it("round-trips custom tool events and incremental history over WebSocket", async () => {
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
        socket.send(JSON.stringify({ type: "response.create", model: "codex-test", ...body }));
      });
    const first = await turn(initial(true));
    const response = present(first.at(-1)).response as Wire;
    validateOutput(response);
    expect(
      first.find((event) => event.type === "response.custom_tool_call_input.delta"),
    ).toHaveProperty("delta", rawInput);
    await turn({ previous_response_id: response.id, input: results });
    validateHistory(protocol, present(bodies[1]));
  });

  it.each([
    false,
    true,
  ])("does not complete or cache malformed custom calls (stream=%s)", async (stream) => {
    const { app } = setup(protocol, true);
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "codex-test", stream, ...initial(false) },
    });
    if (!stream) expect(first.statusCode).toBe(500);
    else {
      const events = sse(first.body);
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(events.some((event) => event.type === "response.custom_tool_call_input.done")).toBe(
        false,
      );
      expect(events.at(-1)?.type).toBe("error");
    }
  });
});
