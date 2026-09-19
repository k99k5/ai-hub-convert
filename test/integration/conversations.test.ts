import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Environment } from "../../src/config.js";
import { chatStream, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Protocol = "chat" | "responses";
const apps: ReturnType<typeof buildApp>[] = [];
const headers = { authorization: "Bearer caller-key" };
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function answer(
  protocol: Protocol,
  round: number,
  stream: boolean,
  tool = false,
  incomplete = false,
): Response {
  const response =
    protocol === "chat"
      ? {
          id: `chat_${round}`,
          object: "chat.completion",
          model: "m",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: incomplete ? "length" : tool ? "tool_calls" : "stop",
              message: tool
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: { name: "lookup", arguments: '{"business_extra":"kept"}' },
                      },
                    ],
                  }
                : { role: "assistant", content: `answer ${round}` },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }
      : {
          id: `resp_${round}`,
          object: "response",
          model: "m",
          status: incomplete ? "incomplete" : "completed",
          ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: tool
            ? [
                {
                  id: `fc_${round}`,
                  type: "function_call",
                  status: "completed",
                  call_id: "call_1",
                  name: "lookup",
                  arguments: '{"business_extra":"kept"}',
                },
              ]
            : [
                {
                  id: `msg_${round}`,
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: `answer ${round}`, annotations: [] }],
                },
              ],
          usage: { input_tokens: 3, output_tokens: 2 },
        };
  return stream
    ? protocol === "chat"
      ? chatStream(response)
      : responsesStream(response)
    : Response.json(response);
}

function setup(
  protocol: Protocol = "chat",
  env: Environment = {},
  respond?: (round: number, body: Wire, signal: AbortSignal) => Response | Promise<Response>,
) {
  const calls: Wire[] = [];
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: protocol,
      ...env,
    }),
    logger: false,
    upstreamFetch: async (_url, init) => {
      const body = JSON.parse(init?.body as string) as Wire;
      calls.push(body);
      return respond
        ? respond(calls.length, body, init?.signal as AbortSignal)
        : answer(protocol, calls.length, body.stream === true);
    },
  });
  apps.push(app);
  const client = new OpenAI({
    apiKey: "caller-key",
    baseURL: "https://gateway.test/v1",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const response = await app.inject({
        method: request.method as "GET" | "POST" | "DELETE",
        url: new URL(request.url).pathname + new URL(request.url).search,
        headers: Object.fromEntries(request.headers.entries()),
        ...(request.body ? { payload: await request.text() } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: new Headers(response.headers as Record<string, string>),
      });
    },
  });
  const post = (payload: Wire, key = "caller-key") =>
    app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: "m", ...payload },
    });
  return { app, calls, client, post };
}

function terminal(response: { statusCode: number; body: string }): {
  response: Wire;
  events: Wire[];
} {
  expect(response.statusCode, response.body).toBe(200);
  if (!response.body.startsWith("event:"))
    return { response: JSON.parse(response.body) as Wire, events: [] };
  const events = response.body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Wire);
  const end = events.find(
    (event) => event.type === "response.completed" || event.type === "response.incomplete",
  );
  expect(end, response.body).toBeDefined();
  expect(response.body).toContain("data: [DONE]");
  return { response: end?.response as Wire, events };
}

function texts(body: Wire, protocol: Protocol): string[] {
  return (body[protocol === "chat" ? "messages" : "input"] as Wire[]).map((item) =>
    typeof item.content === "string"
      ? item.content
      : (item.content as Wire[]).map((part) => part.text).join(""),
  );
}

describe("Conversations API", () => {
  it("works with SDK creation, metadata, item pagination, retrieval and deletion", async () => {
    const { client, calls } = setup();
    const conversation = await client.conversations.create({
      metadata: { topic: "demo" },
      items: [{ role: "user", content: "seed" }],
    });
    expect(conversation).toMatchObject({ object: "conversation", metadata: { topic: "demo" } });
    expect(conversation.id).toMatch(/^conv_/);
    expect((await client.conversations.retrieve(conversation.id)).id).toBe(conversation.id);
    expect(
      (await client.conversations.update(conversation.id, { metadata: { topic: "updated" } }))
        .metadata,
    ).toEqual({ topic: "updated" });
    const added = await client.conversations.items.create(conversation.id, {
      items: Array.from({ length: 20 }, (_, index) => ({ role: "user", content: `item ${index}` })),
    });
    expect(added.data).toHaveLength(20);
    const all: Wire[] = [];
    for await (const item of client.conversations.items.list(conversation.id, {
      limit: 3,
      order: "asc",
    }))
      all.push(item as unknown as Wire);
    expect(all).toHaveLength(21);
    expect(all[0]).toMatchObject({
      type: "message",
      role: "user",
      status: "completed",
      content: [{ type: "input_text", text: "seed" }],
    });
    const id = all[0]?.id as string;
    expect(
      await client.conversations.items.retrieve(id, { conversation_id: conversation.id }),
    ).toEqual(all[0]);
    const desc = await client.conversations.items.list(conversation.id, { limit: 1 });
    expect(desc.data[0]?.id).toBe(all.at(-1)?.id);
    expect(
      await client.conversations.items.delete(id, { conversation_id: conversation.id }),
    ).toHaveProperty("id", conversation.id);
    await expect(
      client.conversations.items.retrieve(id, { conversation_id: conversation.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await client.conversations.delete(conversation.id)).toEqual({
      id: conversation.id,
      object: "conversation.deleted",
      deleted: true,
    });
    await expect(client.conversations.retrieve(conversation.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(0);
  });

  it.each(
    (["chat", "responses"] as const).flatMap((protocol) =>
      [false, true].map((stream) => ({ protocol, stream })),
    ),
  )("loads shared history and commits only input/output for %j", async ({ protocol, stream }) => {
    const { client, calls, post } = setup(protocol);
    const conversation = await client.conversations.create({
      metadata: { topic: "keep" },
      items: [{ role: "user", content: "seed" }],
    });
    const first = terminal(
      await post({
        conversation: conversation.id,
        input: "first",
        instructions: "this turn only",
        metadata: { request_only: "yes" },
        store: true,
        stream,
      }),
    );
    const second = terminal(
      await post({
        conversation: { id: conversation.id, client_extra: "private" },
        input: [{ role: "user", content: "next", client_extra: "private" }],
        stream: !stream,
      }),
    );
    expect(first.response.conversation).toEqual({ id: conversation.id });
    expect(second.response.conversation).toEqual({ id: conversation.id });
    for (const event of [...first.events, ...second.events]) {
      if (event.response)
        expect((event.response as Wire).conversation).toEqual({ id: conversation.id });
    }
    expect(texts(calls[0] as Wire, protocol)).toEqual(["this turn only", "seed", "first"]);
    expect(texts(calls[1] as Wire, protocol)).toEqual(["seed", "first", "answer 1", "next"]);
    for (const body of calls) {
      expect(body.conversation).toBeUndefined();
      expect(body.previous_response_id).toBeUndefined();
      expect(body.store).toBe(false);
      expect(JSON.stringify(body)).not.toContain("private");
    }
    const saved = await client.conversations.items.list(conversation.id, { order: "asc" });
    expect(saved.data).toHaveLength(5);
    expect(JSON.stringify(saved)).not.toContain("this turn only");
    expect((await client.conversations.retrieve(conversation.id)).metadata).toEqual({
      topic: "keep",
    });
    terminal(
      await post({
        previous_response_id: second.response.id,
        input: "fork without modifying conversation",
      }),
    );
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(5);
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("replays function calls and results on %s", async (protocol) => {
    const { client, post, calls } = setup(protocol, {}, (round, body) =>
      answer(protocol, round, body.stream === true, round === 1),
    );
    const conversation = await client.conversations.create();
    const tools = [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: { business_extra: { type: "string" } } },
      },
    ];
    terminal(await post({ conversation: conversation.id, input: "search", tools, stream: true }));
    terminal(
      await post({
        conversation: conversation.id,
        tools,
        input: [
          {
            type: "function_call_output",
            call_id: "call_1",
            output: '{"business_extra":"result"}',
          },
        ],
      }),
    );
    expect(JSON.stringify(calls[1])).toContain("business_extra");
    expect(JSON.stringify(calls[1])).toContain("call_1");
    const saved = await client.conversations.items.list(conversation.id, { order: "asc" });
    expect(saved.data.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(saved.data[1]).toMatchObject({ arguments: '{"business_extra":"kept"}' });
    expect(saved.data[2]).toMatchObject({ output: '{"business_extra":"result"}' });
  });

  it("isolates all conversation operations by API key and clears state between app instances", async () => {
    const { app, client, calls, post } = setup();
    const conversation = await client.conversations.create({
      items: [{ role: "user", content: "private-seed" }],
    });
    const saved = await client.conversations.items.list(conversation.id);
    for (const { method, suffix, payload } of [
      { method: "GET", suffix: "" },
      { method: "DELETE", suffix: "" },
      { method: "POST", suffix: "", payload: { metadata: {} } },
      { method: "GET", suffix: "/items" },
      { method: "POST", suffix: "/items", payload: { items: [] } },
      { method: "GET", suffix: `/items/${saved.data[0]?.id}` },
      { method: "DELETE", suffix: `/items/${saved.data[0]?.id}` },
    ] as const) {
      const response = await app.inject({
        method,
        url: `/v1/conversations/${conversation.id}${suffix}`,
        headers: { authorization: "Bearer other-key" },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain("private-seed");
    }
    expect(
      (await post({ conversation: conversation.id, input: "next" }, "other-key")).statusCode,
    ).toBe(404);
    const restarted = setup();
    await expect(restarted.client.conversations.retrieve(conversation.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    false,
    true,
  ])("rolls back failed or incomplete generations and releases the conversation, stream=%s", async (stream) => {
    const { client, post } = setup("responses", {}, (round, body) =>
      round === 1
        ? Response.json({ error: { message: "private-upstream" } }, { status: 500 })
        : answer("responses", round, body.stream === true, false, round === 2),
    );
    const conversation = await client.conversations.create({
      items: [{ role: "user", content: "seed" }],
    });
    expect(
      (await post({ conversation: conversation.id, input: "failed", stream })).statusCode,
    ).toBe(500);
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(1);
    expect(
      terminal(await post({ conversation: conversation.id, input: "incomplete", stream })).response
        .status,
    ).toBe("incomplete");
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(1);
    terminal(await post({ conversation: conversation.id, input: "retry", stream }));
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(3);
  });

  it("rejects concurrent mutation, permits reads and other conversations, and releases after completion", async () => {
    const gate = Promise.withResolvers<Response>();
    const { app, client, post, calls } = setup("chat", {}, (round, body) =>
      round === 1 ? gate.promise : answer("chat", round, body.stream === true),
    );
    const conversation = await client.conversations.create({
      items: [{ role: "user", content: "seed" }],
    });
    const first = post({ conversation: conversation.id, input: "first" });
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect((await post({ conversation: conversation.id, input: "conflict" })).statusCode).toBe(
        409,
      );
      for (const operation of [
        () => client.conversations.delete(conversation.id),
        () => client.conversations.update(conversation.id, { metadata: {} }),
        () => client.conversations.items.create(conversation.id, { items: [] }),
      ])
        await expect(operation()).rejects.toMatchObject({ status: 409 });
      expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(1);
      const other = await client.conversations.create();
      terminal(await post({ conversation: other.id, input: "independent" }));
      expect(
        (await app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}`, headers }))
          .statusCode,
      ).toBe(200);
    } finally {
      gate.resolve(answer("chat", 1, false));
    }
    terminal(await first);
    terminal(await post({ conversation: conversation.id, input: "next" }));
  });

  it("releases the conversation after incompatible input fails during preparation", async () => {
    const { client, post, calls } = setup();
    const conversation = await client.conversations.create();
    const invalid = await post({
      conversation: conversation.id,
      input: [{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" }],
    });
    expect(invalid.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await client.conversations.items.list(conversation.id)).data).toEqual([]);
    terminal(await post({ conversation: conversation.id, input: "retry", model: "another-model" }));
    expect(calls[0]?.model).toBe("another-model");
  });

  it("does not commit an upstream stream with trailing corruption", async () => {
    const { client, post } = setup("responses", {}, async (round, body) => {
      if (round > 1) return answer("responses", round, body.stream === true);
      const stream = await answer("responses", round, true).text();
      return new Response(`${stream}\ndata: {broken}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const conversation = await client.conversations.create();
    const failed = await post({ conversation: conversation.id, input: "corrupt", stream: true });
    expect(failed.body).toContain("event: error");
    expect((await client.conversations.items.list(conversation.id)).data).toEqual([]);
    terminal(await post({ conversation: conversation.id, input: "retry" }));
  });

  it.each([
    false,
    true,
  ])("reports capacity failures without silently losing saved history, stream=%s", async (stream) => {
    const { client, post } = setup(
      "chat",
      { CONVERSATIONS_MAX_CREDENTIAL_BYTES: "1100" },
      (round, body) => {
        if (round > 1) return answer("chat", round, body.stream === true);
        const response = {
          id: "chat_large",
          object: "chat.completion",
          model: "m",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "x".repeat(2000) },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
        return stream ? chatStream(response) : Response.json(response);
      },
    );
    const conversation = await client.conversations.create();
    const failed = await post({ conversation: conversation.id, input: "first", stream });
    expect(failed.statusCode).toBe(stream ? 200 : 429);
    expect(failed.body).toContain("conversation_capacity_exceeded");
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(0);
    terminal(await post({ conversation: conversation.id, input: "retry" }));
    expect((await client.conversations.items.list(conversation.id)).data).toHaveLength(2);
  });

  it("validates known fields, conflicts, pagination and body boundaries without forwarding unknown fields", async () => {
    const { app, client, post, calls } = setup();
    for (const payload of [
      { metadata: { invalid: 1 } },
      { metadata: [] },
      { items: "bad" },
      { items: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) },
      { items: [{ type: "item_reference", id: "msg_missing" }] },
      { items: [{ role: "user", content: [{ type: "unknown" }] }] },
    ]) {
      expect(
        (await app.inject({ method: "POST", url: "/v1/conversations", headers, payload }))
          .statusCode,
      ).toBe(400);
    }
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers,
      payload: {
        client_extra: "private",
        items: [{ role: "user", content: "hello", client_extra: "private" }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id as string;
    for (const conversation of ["", 1, true, [], {}, { id: 1 }])
      expect((await post({ conversation, input: "x" })).statusCode).toBe(400);
    expect(
      (await post({ conversation: id, previous_response_id: "resp_x", input: "x" })).statusCode,
    ).toBe(400);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=no",
      "limit=1.5",
      "order=other",
      "after=missing",
      "include[]=unsupported",
    ]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/conversations/${id}/items?${query}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(JSON.stringify((await client.conversations.items.list(id)).data)).not.toContain(
      "private",
    );
    expect(
      (await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })).statusCode,
    ).toBe(401);
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: { ...headers, "content-type": "application/json" },
      payload: "{",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(calls).toHaveLength(0);
    terminal(await post({ conversation: null, input: "standalone" }));
  });
});
