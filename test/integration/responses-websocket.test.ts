import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Environment } from "../../src/config.js";
import { chatStream, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Protocol = "chat" | "responses";
const apps: Array<ReturnType<typeof buildApp>> = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function answer(protocol: Protocol, round = 1, call = false, incomplete = false): Response {
  if (protocol === "chat") {
    return chatStream({
      id: `chat_${round}`,
      model: "m",
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: incomplete ? "length" : call ? "tool_calls" : "stop",
          message: call
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"hello"}' },
                  },
                ],
              }
            : { role: "assistant", content: `answer ${round}` },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });
  }
  return responsesStream({
    id: `resp_${round}`,
    object: "response",
    model: "m",
    status: incomplete ? "incomplete" : "completed",
    ...(incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: call
      ? [
          {
            id: `fc_${round}`,
            type: "function_call",
            status: "completed",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"q":"hello"}',
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
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 5 },
    },
  });
}

async function setup(
  protocol: Protocol = "chat",
  env: Environment = {},
  respond?: (round: number, body: Wire, signal: AbortSignal) => Response | Promise<Response>,
) {
  const calls: Array<{
    url: string;
    body: Wire;
    signal: AbortSignal;
    authorization: string | null;
  }> = [];
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: protocol,
      ...env,
    }),
    logger: false,
    upstreamFetch: async (url, init) => {
      const body = JSON.parse(init?.body as string) as Wire;
      const signal = init?.signal as AbortSignal;
      calls.push({
        url: String(url),
        body,
        signal,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return respond ? respond(calls.length, body, signal) : answer(protocol, calls.length);
    },
  });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, calls, url: `${address.replace("http:", "ws:")}/v1/responses` };
}

async function connect(url: string, key = "caller-key") {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
  sockets.push(socket);
  const events: Wire[] = [];
  const raw: string[] = [];
  socket.on("message", (data) => {
    raw.push(data.toString());
    try {
      events.push(JSON.parse(data.toString()) as Wire);
    } catch {
      events.push({ type: "invalid_wire", data: data.toString() });
    }
  });
  await once(socket, "open");
  const until = async (predicate: (event: Wire) => boolean, start = 0): Promise<Wire> => {
    let found: Wire | undefined;
    await vi.waitFor(
      () => {
        found = events.slice(start).find(predicate);
        expect(found, JSON.stringify(events)).toBeDefined();
      },
      { timeout: 3000, interval: 5 },
    );
    return found as Wire;
  };
  const send = (event: Wire) => socket.send(JSON.stringify(event));
  const turn = async (body: Wire = {}) => {
    const start = events.length;
    send({ type: "response.create", model: "m", input: "hello", ...body });
    return until(
      (event) =>
        ["response.completed", "response.incomplete", "error"].includes(event.type as string),
      start,
    );
  };
  return { socket, events, raw, until, send, turn };
}

function responseId(event: Wire): string {
  return (event.response as Wire).id as string;
}

describe("Responses WebSocket transport", () => {
  it("renews prewarmed conversations, protects long generations, and rejects expired history", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const gate = Promise.withResolvers<Response>();
    const { app, url, calls } = await setup(
      "chat",
      { CONVERSATIONS_TTL_MS: "1000" },
      () => gate.promise,
    );
    const headers = { authorization: "Bearer caller-key" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers,
      payload: {},
    });
    const conversation = created.json().id as string;
    const peer = await connect(url);
    now = 900;
    expect(
      await peer.turn({ conversation, generate: false, input: "prewarm context" }),
    ).toHaveProperty("type", "response.completed");
    expect(calls).toHaveLength(0);
    now = 1800;
    const start = peer.events.length;
    peer.send({ type: "response.create", model: "m", conversation, input: "long turn" });
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      now = 5000;
      const busy = await app.inject({
        method: "GET",
        url: `/v1/conversations/${conversation}/items`,
        headers,
      });
      expect(busy.statusCode).toBe(200);
      expect(busy.json().data).toHaveLength(1);
    } finally {
      gate.resolve(answer("chat"));
    }
    await peer.until((event) => event.type === "response.completed", start);
    expect(JSON.stringify(calls[0]?.body)).toContain("prewarm context");
    now = 5900;
    const saved = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversation}/items`,
      headers,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data).toHaveLength(3);
    now = 6900;
    expect(await peer.turn({ conversation, input: "expired" })).toMatchObject({
      type: "error",
      status: 404,
      error: { code: "conversation_not_found" },
    });
    expect(calls).toHaveLength(1);
    expect(peer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("shares a conversation across prewarm, connections and HTTP on %s", async (protocol) => {
    const { app, url, calls } = await setup(protocol);
    const headers = { authorization: "Bearer caller-key" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers,
      payload: { items: [{ role: "user", content: "seed context" }] },
    });
    expect(created.statusCode).toBe(200);
    const conversation = created.json().id as string;
    const firstPeer = await connect(url);
    const prewarm = await firstPeer.turn({
      conversation,
      generate: false,
      input: "prewarm context",
    });
    expect(prewarm.type).toBe("response.completed");
    expect((prewarm.response as Wire).conversation).toEqual({ id: conversation });
    const first = await firstPeer.turn({
      conversation: { id: conversation },
      input: "first",
      instructions: "one turn only",
    });
    expect(first.type).toBe("response.completed");
    firstPeer.socket.close();
    await once(firstPeer.socket, "close");
    const peer = await connect(url);
    const second = await peer.turn({ conversation, input: "second" });
    expect(second.type).toBe("response.completed");
    expect((second.response as Wire).conversation).toEqual({ id: conversation });
    const http = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers,
      payload: { model: "m", conversation, input: "http next", stream: true },
    });
    expect(http.statusCode, http.body).toBe(200);
    expect(http.body).toContain("event: response.completed");
    expect(calls).toHaveLength(3);
    const history = JSON.stringify(calls[2]?.body);
    for (const text of [
      "seed context",
      "prewarm context",
      "first",
      "answer 1",
      "second",
      "answer 2",
      "http next",
    ])
      expect(history).toContain(text);
    expect(history).not.toContain("one turn only");
    expect(calls.every(({ body }) => body.conversation === undefined && body.store === false)).toBe(
      true,
    );
    const stored = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversation}/items`,
      headers,
    });
    expect(stored.json().data).toHaveLength(8);
    const conflict = await peer.turn({
      conversation,
      previous_response_id: responseId(second),
      input: "conflict",
    });
    expect(conflict).toMatchObject({
      type: "error",
      status: 400,
      error: { code: "invalid_request" },
    });
    const unauthorized = await connect(url, "other-key");
    expect(await unauthorized.turn({ conversation })).toMatchObject({
      type: "error",
      status: 404,
      error: { code: "conversation_not_found" },
    });
  });

  it("releases a conversation after WS disconnect without appending a partial turn", async () => {
    let aborted = false;
    const { app, url, calls } = await setup("chat", {}, (round, _body, signal) => {
      if (round > 1) return answer("chat", round);
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    });
    const headers = { authorization: "Bearer caller-key" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers,
      payload: {},
    });
    const conversation = created.json().id as string;
    const first = await connect(url);
    first.send({ type: "response.create", model: "m", conversation, input: "cancelled input" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const peer = await connect(url);
    expect(await peer.turn({ conversation })).toMatchObject({
      type: "error",
      status: 409,
      error: { code: "conversation_busy" },
    });
    first.socket.terminate();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(async () => {
      const updated = await app.inject({
        method: "POST",
        url: `/v1/conversations/${conversation}`,
        headers,
        payload: { metadata: {} },
      });
      expect(updated.statusCode).toBe(200);
    });
    const stored = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversation}/items`,
      headers,
    });
    expect(stored.json().data).toEqual([]);
    expect(await peer.turn({ conversation, input: "retry" })).toHaveProperty(
      "type",
      "response.completed",
    );
    expect(JSON.stringify(calls[1]?.body)).not.toContain("cancelled input");
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("ignores unknown frame and input fields across prewarm and continuation on %s", async (protocol) => {
    const { url, calls } = await setup(protocol, { WEBSOCKET_HISTORY_LIMIT_BYTES: "2048" });
    const peer = await connect(url);
    const prewarm = await peer.turn({
      generate: false,
      client_extra: "private-frame",
      input: [
        {
          role: "user",
          client_extra: "private-history".repeat(400),
          content: [
            { type: "input_text", text: "prewarm context", client_extra: "private-content" },
          ],
        },
      ],
    });
    expect(prewarm.type).toBe("response.completed");
    expect(calls).toHaveLength(0);
    const first = await peer.turn({
      previous_response_id: responseId(prewarm),
      input: "first",
      client_extra: true,
    });
    expect(first.type).toBe("response.completed");
    const second = await peer.turn({
      previous_response_id: responseId(first),
      input: "next",
      client_extra: null,
    });
    expect(second.type).toBe("response.completed");
    expect(calls).toHaveLength(2);
    const history = JSON.stringify(calls[1]?.body);
    expect(history).toContain("prewarm context");
    expect(history).toContain("first");
    expect(history).toContain("answer 1");
    expect(history).toContain("next");
    expect(JSON.stringify(calls.map(({ body }) => body))).not.toContain("private-");
    expect(JSON.stringify(peer.events)).not.toContain("private-");
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("accepts Codex stream:true and client_metadata during prewarm and continuation on %s", async (protocol) => {
    const { url, calls } = await setup(protocol);
    const peer = await connect(url);
    const request = {
      stream: true,
      store: false,
      instructions: "Answer briefly",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "codex-cache",
      client_metadata: {
        turn_id: "private-turn",
        context: { model: "private-model", stream: false },
      },
    };
    const prewarm = await peer.turn({ ...request, input: [], generate: false });
    expect(prewarm.type).toBe("response.completed");
    expect(calls).toHaveLength(0);
    const first = await peer.turn({
      ...request,
      previous_response_id: responseId(prewarm),
      input: "Codex first",
    });
    expect(first.type).toBe("response.completed");
    expect(
      (
        await peer.turn({
          ...request,
          previous_response_id: responseId(first),
          input: "Codex next",
        })
      ).type,
    ).toBe("response.completed");
    expect(calls).toHaveLength(2);
    for (const { body } of calls) {
      expect(body).toMatchObject({ stream: true, store: false, prompt_cache_key: "codex-cache" });
      expect(body.client_metadata).toBeUndefined();
      expect(body.metadata).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("private-");
    }
    expect(JSON.stringify(calls[1]?.body)).toContain("Codex first");
    expect(JSON.stringify(calls[1]?.body)).toContain("answer 1");
    expect(JSON.stringify(peer.events)).not.toContain("private-");
    expect(peer.events.some((event) => event.type === "response.output_text.delta")).toBe(true);
  });

  it.each([
    "/v1",
    "",
  ])("works with the official OpenAI ResponsesWS client and continuation (base path=%s)", async (basePath) => {
    const { url, calls } = await setup();
    const client = new OpenAI({
      apiKey: "caller-key",
      baseURL: `${new URL(url).origin.replace("ws:", "http:")}${basePath}`,
      maxRetries: 0,
    });
    const ws = new ResponsesWS(client);
    const responses: string[] = [];
    try {
      ws.send({ type: "response.create", model: "m", input: "SDK request", store: false });
      for await (const event of ws) {
        if (event.type === "error") throw event.error;
        if (event.type !== "message") continue;
        if (event.message.type === "error") throw new Error(JSON.stringify(event.message));
        if (event.message.type === "response.completed") {
          responses.push(event.message.response.id);
          if (responses.length === 2) break;
          ws.send({
            type: "response.create",
            model: "m",
            input: "SDK continuation",
            previous_response_id: event.message.response.id,
            store: false,
          });
        }
      }
      expect(responses).toHaveLength(2);
      expect(JSON.stringify(calls[1]?.body)).toContain("SDK request");
      expect(JSON.stringify(calls[1]?.body)).toContain("answer 1");
    } finally {
      ws.close();
    }
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("streams JSON events using the %s upstream and reuses the connection", async (protocol) => {
    const { url, calls } = await setup(protocol);
    const peer = await connect(url);
    const first = await peer.turn({ store: true, prompt_cache_key: "stable-key" });
    expect(first).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ content: [{ text: "answer 1" }] }],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 5 } },
      },
    });
    expect(peer.events.map((event) => event.type)).toContain("response.output_text.delta");
    expect(peer.events.map((event) => event.sequence_number)).toEqual(peer.events.map((_, i) => i));
    expect(peer.events.every((event) => event.stream_id === undefined)).toBe(true);
    expect(peer.raw.every((raw) => raw.startsWith("{"))).toBe(true);
    await peer.turn({ input: "new conversation" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      authorization: "Bearer caller-key",
      body: { stream: true, store: false, prompt_cache_key: "stable-key" },
    });
    expect(calls[0]?.url).toBe(
      `https://upstream.test/v1/${protocol === "chat" ? "chat/completions" : "responses"}`,
    );
    expect(JSON.stringify(calls[1]?.body)).not.toContain("answer 1");
  });

  it.each<Protocol>([
    "chat",
    "responses",
  ])("replays tool calls and incremental input on %s without retaining prior instructions", async (protocol) => {
    const { url, calls } = await setup(protocol, {}, (round) =>
      answer(protocol, round, round === 1),
    );
    const peer = await connect(url);
    const tools = [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const first = await peer.turn({ instructions: "old instructions", tools });
    const second = await peer.turn({
      previous_response_id: responseId(first),
      instructions: "new instructions",
      tools,
      input: [{ type: "function_call_output", call_id: "call_1", output: "tool result" }],
    });
    expect(second.type).toBe("response.completed");
    const body = calls[1]?.body as Wire;
    expect(body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(body)).toContain("hello");
    expect(JSON.stringify(body)).toContain("tool result");
    expect(JSON.stringify(body)).not.toContain("old instructions");
    expect(JSON.stringify(body)).toContain("new instructions");
    if (protocol === "chat")
      expect(body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "tool result",
      });
    else
      expect(body.input).toContainEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: "tool result",
      });
  });

  it("supports local warmup, fresh null continuations, and latest-response eviction", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    const warmup = await peer.turn({ generate: false, input: "warmup input" });
    expect(calls).toHaveLength(0);
    expect((warmup.response as Wire).output).toEqual([]);
    const generated = await peer.turn({
      previous_response_id: responseId(warmup),
      input: "next input",
    });
    expect(generated.type).toBe("response.completed");
    expect(JSON.stringify(calls[0]?.body)).toContain("warmup input");
    expect(await peer.turn({ previous_response_id: responseId(warmup) })).toMatchObject({
      type: "error",
      error: { code: "previous_response_not_found" },
    });
    await peer.turn({ previous_response_id: null, input: "fresh input" });
    expect(JSON.stringify(calls.at(-1)?.body)).not.toContain("warmup input");
  });

  it("runs named streams concurrently, queues the same stream, and forks cached parents", async () => {
    const slow = Promise.withResolvers<void>();
    const { url, calls } = await setup("chat", {}, async (round) => {
      if (round === 1) await slow.promise;
      return answer("chat", round);
    });
    const peer = await connect(url);
    const event = { type: "response.create", model: "m", input: "first", stream_id: "slow" };
    peer.send(event);
    peer.send({ ...event, input: "queued" });
    peer.send({ ...event, input: "parallel", stream_id: "fast" });
    const parent = await peer.until(
      (event) => event.stream_id === "fast" && event.type === "response.completed",
    );
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toContain("parallel");
    const fork = await peer.turn({
      stream_id: "fork",
      previous_response_id: responseId(parent),
      input: "branch",
    });
    expect(fork).toMatchObject({ type: "response.completed", stream_id: "fork" });
    expect(JSON.stringify(calls[2]?.body)).toContain("parallel");
    expect(JSON.stringify(calls[2]?.body)).toContain("answer 2");
    slow.resolve();
    await vi.waitFor(() =>
      expect(
        peer.events.filter(
          (event) => event.stream_id === "slow" && event.type === "response.completed",
        ),
      ).toHaveLength(2),
    );
    expect(JSON.stringify(calls[3]?.body)).toContain("queued");
    expect(calls.every(({ body }) => body.stream_id === undefined)).toBe(true);
  });

  it("resolves a continuation queued immediately after response.created", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    peer.socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Wire;
      if (event.type === "response.created" && calls.length === 1) {
        peer.send({
          type: "response.create",
          model: "m",
          input: "queued continuation",
          previous_response_id: responseId(event),
        });
      }
    });
    await peer.turn();
    await vi.waitFor(() =>
      expect(peer.events.filter((event) => event.type === "response.completed")).toHaveLength(2),
    );
    expect(JSON.stringify(calls[1]?.body)).toContain("answer 1");
  });

  it("isolates history by connection and model, including clients with the same credential", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    const first = await peer.turn();
    for (const key of ["caller-key", "other-key"]) {
      const other = await connect(url, key);
      expect(await other.turn({ previous_response_id: responseId(first) })).toMatchObject({
        error: { code: "previous_response_not_found" },
      });
    }
    expect(
      await peer.turn({ model: "other-model", previous_response_id: responseId(first) }),
    ).toMatchObject({ error: { code: "previous_response_not_found" } });
    expect(calls).toHaveLength(1);
  });

  it("expands item references into durable connection-local input before their next continuation", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    const first = await peer.turn();
    const item = ((first.response as Wire).output as Wire[])[0];
    const second = await peer.turn({
      input: [
        { type: "item_reference", id: item?.id },
        { role: "user", content: "reference input" },
      ],
    });
    await peer.turn({ previous_response_id: responseId(second), input: "next" });
    expect(JSON.stringify(calls[2]?.body)).toContain("answer 1");
    expect(JSON.stringify(calls[2]?.body)).not.toContain("item_reference");
  });

  it("keeps HTTP response history separate from connection-local WebSocket history", async () => {
    const { app, url, calls } = await setup();
    const httpPost = (body: Wire = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer caller-key" },
        payload: { model: "m", input: "HTTP input", stream: true, ...body },
      });
    const first = await httpPost();
    const completed = first.body
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as Wire)
      .find((event) => event.type === "response.completed") as Wire;
    const peer = await connect(url);
    expect(await peer.turn({ previous_response_id: responseId(completed) })).toMatchObject({
      error: { code: "previous_response_not_found" },
    });
    const ws = await peer.turn();
    const result = await httpPost({ previous_response_id: responseId(ws) });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({ error: { code: "previous_response_not_found" } });
    expect(calls).toHaveLength(2);
    expect(
      (await httpPost({ previous_response_id: responseId(completed), input: "HTTP continuation" }))
        .statusCode,
    ).toBe(200);
    expect(JSON.stringify(calls[2]?.body)).toContain("HTTP input");
  });

  it.each([
    [{ type: "response.cancel" }, "invalid_request"],
    [{ stream_id: "" }, "invalid_stream_id"],
    [{ stream_id: "bad stream" }, "invalid_stream_id"],
    [{ stream_id: "x".repeat(257) }, "invalid_stream_id"],
    [{ generate: "false" }, "invalid_request"],
    [{ stream: false }, "invalid_request"],
    [{ stream: null }, "invalid_request"],
    [{ stream: "true" }, "invalid_request"],
    [{ stream: 1 }, "invalid_request"],
    [{ client_metadata: [] }, "invalid_request"],
    [{ client_metadata: "private-client" }, "invalid_request"],
    [{ background: false }, "invalid_request"],
    [{ previous_response_id: 5 }, "invalid_request"],
    [{ previous_response_id: "" }, "invalid_request"],
    [{ model: null }, "invalid_request"],
    [{ input: [{ type: "item_reference", id: "missing" }] }, "reference_cache_miss"],
  ])("rejects invalid frames and keeps the connection usable: %j", async (body, code) => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    expect(await peer.turn(body as Wire)).toMatchObject({
      type: "error",
      status: 400,
      error: { code },
    });
    expect(calls).toHaveLength(0);
    expect((await peer.turn()).type).toBe("response.completed");
  });

  it("rejects malformed JSON, arrays and binary messages without echoing payloads", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    for (const input of ['{"private-prompt"', "[]", Buffer.from("private-binary")]) {
      const start = peer.events.length;
      peer.socket.send(input);
      const error = await peer.until((event) => event.type === "error", start);
      expect(JSON.stringify(error)).not.toContain("private-");
    }
    expect(calls).toHaveLength(0);
    expect((await peer.turn()).type).toBe("response.completed");
  });

  it.each([
    "/v1/responses",
    "/responses?client=codex",
  ])("requires Bearer authentication before upgrading and returns 426 for ordinary GET: %s", async (path) => {
    const { app, url, calls } = await setup();
    for (const headers of [
      {},
      { authorization: "Basic private-key" },
      { "x-api-key": "private-key" },
    ]) {
      const socket = new WebSocket(`${new URL(url).origin}${path}`, { headers });
      sockets.push(socket);
      const [error] = await once(socket, "error");
      expect((error as Error).message).toContain("401");
    }
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer key" },
    });
    expect(response.statusCode).toBe(426);
    expect(calls).toHaveLength(0);
  });

  it("reports sanitized upstream failures with stream_id and allows recovery", async () => {
    const { url } = await setup("chat", {}, (round) =>
      round === 1
        ? Response.json({ error: { message: "private-key private-prompt" } }, { status: 429 })
        : answer("chat", round),
    );
    const peer = await connect(url);
    const error = await peer.turn({ stream_id: "main" });
    expect(error).toMatchObject({
      type: "error",
      stream_id: "main",
      status: 429,
      error: { code: "rate_limit_exceeded" },
    });
    expect(JSON.stringify(error)).not.toContain("private-");
    expect((await peer.turn({ stream_id: "main" })).type).toBe("response.completed");
  });

  it("does not cache incomplete responses", async () => {
    const { url } = await setup("chat", {}, (round) => answer("chat", round, false, true));
    const peer = await connect(url);
    const partial = await peer.turn();
    expect(partial.type).toBe("response.incomplete");
    expect(await peer.turn({ previous_response_id: responseId(partial) })).toMatchObject({
      error: { code: "previous_response_not_found" },
    });
  });

  it("invalidates a failed same-stream continuation but preserves a cross-stream parent", async () => {
    const { url } = await setup("chat", {}, (round) =>
      round === 2 || round === 4
        ? Response.json({ error: { message: "private error" } }, { status: 500 })
        : answer("chat", round),
    );
    const peer = await connect(url);
    const first = await peer.turn({ stream_id: "source" });
    expect(
      (await peer.turn({ stream_id: "fork", previous_response_id: responseId(first) })).type,
    ).toBe("error");
    const second = await peer.turn({
      stream_id: "source",
      previous_response_id: responseId(first),
    });
    expect(second.type).toBe("response.completed");
    expect(
      (await peer.turn({ stream_id: "source", previous_response_id: responseId(second) })).type,
    ).toBe("error");
    expect(
      await peer.turn({ stream_id: "source", previous_response_id: responseId(second) }),
    ).toMatchObject({ error: { code: "previous_response_not_found" } });
  });

  it("does not commit partial upstream streams and can start a fresh response afterward", async () => {
    const { url } = await setup("chat", {}, (round) =>
      round === 1
        ? new Response(
            `data: ${JSON.stringify({ id: "chat_partial", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          )
        : answer("chat", round),
    );
    const peer = await connect(url);
    expect((await peer.turn()).type).toBe("error");
    const created = peer.events.find((event) => event.type === "response.created") as Wire;
    expect(created).toBeDefined();
    expect(peer.events.some((event) => event.type === "response.completed")).toBe(false);
    expect(await peer.turn({ previous_response_id: responseId(created) })).toMatchObject({
      error: { code: "previous_response_not_found" },
    });
    expect((await peer.turn()).type).toBe("response.completed");
  });

  it("preserves stream output limits on the WebSocket transport", async () => {
    const { url } = await setup("chat", { UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "1" });
    const peer = await connect(url);
    expect(await peer.turn()).toMatchObject({
      type: "error",
      error: { code: "STREAM_OUTPUT_TOO_LARGE" },
    });
    expect(peer.events.some((event) => event.type === "response.completed")).toBe(false);
  });

  it("bounds retained history without losing generated output", async () => {
    const { url } = await setup("chat", { WEBSOCKET_HISTORY_LIMIT_BYTES: "1" });
    const peer = await connect(url);
    const first = await peer.turn();
    expect(first.type).toBe("response.completed");
    expect(await peer.turn({ previous_response_id: responseId(first) })).toMatchObject({
      error: { code: "previous_response_not_found" },
    });
  });

  it("bounds expanded continuation bodies and rejects oversized wire frames", async () => {
    const { url, calls } = await setup("chat", { BODY_LIMIT_BYTES: "512" });
    const peer = await connect(url);
    const first = await peer.turn({ input: "x".repeat(220) });
    expect(
      await peer.turn({ previous_response_id: responseId(first), input: "x".repeat(220) }),
    ).toMatchObject({ status: 413, error: { code: "request_too_large" } });
    expect(calls).toHaveLength(1);
    const closed = once(peer.socket, "close");
    peer.socket.send("x".repeat(513));
    const [code] = await closed;
    expect(code).toBe(1009);
  });

  it("limits pending requests and releases queue capacity after completion", async () => {
    const slow = Promise.withResolvers<void>();
    const { url, calls } = await setup(
      "chat",
      { WEBSOCKET_MAX_PENDING_REQUESTS: "1" },
      async (round) => {
        if (round === 1) await slow.promise;
        return answer("chat", round);
      },
    );
    const peer = await connect(url);
    peer.send({ type: "response.create", model: "m", input: "slow" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(await peer.turn()).toMatchObject({
      status: 429,
      error: { code: "websocket_queue_full" },
    });
    slow.resolve();
    await peer.until((event) => event.type === "response.completed");
    expect((await peer.turn()).type).toBe("response.completed");
  });

  it("limits distinct named streams while leaving the default stream available", async () => {
    const { url, calls } = await setup();
    const peer = await connect(url);
    for (let i = 0; i < 32; i++) await peer.turn({ stream_id: `s${i}`, generate: false });
    expect(await peer.turn({ stream_id: "extra" })).toMatchObject({
      stream_id: "extra",
      error: { code: "websocket_stream_limit_reached" },
    });
    expect((await peer.turn()).type).toBe("response.completed");
    expect((await peer.turn({ stream_id: "s0" })).type).toBe("response.completed");
    expect(calls).toHaveLength(2);
  });

  it.each([
    "disconnect",
    "shutdown",
    "timeout",
  ])("aborts the upstream on %s and drops queued work", async (action) => {
    const started = Promise.withResolvers<AbortSignal>();
    const { url, app, calls } = await setup(
      "chat",
      { UPSTREAM_TIMEOUT_MS: action === "timeout" ? "80" : "5000" },
      (_round, _body, signal) => {
        started.resolve(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    );
    const peer = await connect(url);
    peer.send({ type: "response.create", model: "m", input: "waiting" });
    const signal = await started.promise;
    if (action !== "timeout") peer.send({ type: "response.create", model: "m", input: "queued" });
    if (action === "disconnect") peer.socket.terminate();
    if (action === "shutdown") await app.close();
    if (action === "timeout") await peer.until((event) => event.type === "error");
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    expect(calls).toHaveLength(1);
  });

  it("pings idle connections and expires them with a recoverable error", async () => {
    const { url, calls } = await setup("chat", {
      WEBSOCKET_PING_INTERVAL_MS: "15",
      WEBSOCKET_MAX_CONNECTION_MS: "200",
    });
    const peer = await connect(url);
    let pings = 0;
    peer.socket.on("ping", () => pings++);
    const closed = once(peer.socket, "close");
    expect(await peer.until((event) => event.type === "error")).toMatchObject({
      error: { code: "websocket_connection_limit_reached" },
    });
    await closed;
    expect(pings).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    const final = pings;
    await delay(40);
    expect(pings).toBe(final);
  });

  it("disconnects a client that does not answer pings", async () => {
    const { url } = await setup("chat", { WEBSOCKET_PING_INTERVAL_MS: "30" });
    const socket = new WebSocket(url, {
      headers: { authorization: "Bearer caller-key" },
      autoPong: false,
    });
    sockets.push(socket);
    await once(socket, "open");
    await once(socket, "close");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it.each(["timeout", "shutdown"])("releases blocked WebSocket writes on %s", async (action) => {
    const flood = Promise.withResolvers<void>();
    let frames = 0;
    const { url, app, calls } = await setup(
      "chat",
      {
        WEBSOCKET_PING_INTERVAL_MS: "0",
        UPSTREAM_TIMEOUT_MS: action === "timeout" ? "1500" : "10000",
        UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "67108864",
        UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES: "134217728",
      },
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (frames > 0) await flood.promise;
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({
                    id: "chat_flood",
                    model: "m",
                    choices: [
                      {
                        index: 0,
                        finish_reason: null,
                        delta:
                          frames++ === 0
                            ? { role: "assistant" }
                            : { content: "x".repeat(64 * 1024) },
                      },
                    ],
                  })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const peer = await connect(url);
    let server: WebSocket | undefined;
    const originalSend = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<typeof originalSend>
    ) {
      if (this !== peer.socket) server = this;
      return Reflect.apply(originalSend, this, args);
    });
    try {
      peer.send({ type: "response.create", model: "m", input: "flood" });
      await peer.until((event) => event.type === "response.created");
      peer.socket.pause();
      flood.resolve();
      await vi.waitFor(() => expect(server?.bufferedAmount).toBeGreaterThan(0));
      expect(calls[0]?.signal.aborted).toBe(false);
      if (action === "shutdown") await app.close();
      await vi.waitFor(
        () => {
          expect(calls[0]?.signal.aborted).toBe(true);
          expect(server?.readyState).toBe(WebSocket.CLOSED);
        },
        { timeout: 3000 },
      );
    } finally {
      flood.resolve();
      peer.socket.resume();
      server?.terminate();
    }
  });
});
