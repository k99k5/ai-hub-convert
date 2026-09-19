import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig, type Environment } from "../../src/config.js";
import { chatStream, responsesFrames, responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Protocol = "chat" | "responses";
const protocols: Protocol[] = ["chat", "responses"];
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function answer(
  protocol: Protocol,
  round: number,
  stream: boolean,
  options: { tool?: boolean; incomplete?: boolean; text?: string } = {},
) {
  const text = options.text ?? `answer ${round}`;
  const response =
    protocol === "chat"
      ? {
          id: `chat_${round}`,
          model: "m",
          created: 1,
          choices: [
            {
              index: 0,
              finish_reason: options.incomplete ? "length" : options.tool ? "tool_calls" : "stop",
              message: options.tool
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
                : { role: "assistant", content: text },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }
      : {
          id: `resp_${round}`,
          object: "response",
          model: "m",
          status: options.incomplete ? "incomplete" : "completed",
          ...(options.incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: options.tool
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
                  content: [{ type: "output_text", text, annotations: [] }],
                },
              ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
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
  const calls: Array<{ body: Wire; authorization: string | null; signal: AbortSignal }> = [];
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: protocol,
      ...env,
    }),
    logger: false,
    upstreamFetch: async (url, init) => {
      expect(String(url)).toBe(
        `https://upstream.test/v1/${protocol === "chat" ? "chat/completions" : "responses"}`,
      );
      const body = JSON.parse(init?.body as string) as Wire;
      const signal = init?.signal as AbortSignal;
      calls.push({ body, signal, authorization: new Headers(init?.headers).get("authorization") });
      return respond
        ? respond(calls.length, body, signal)
        : answer(protocol, calls.length, body.stream === true);
    },
  });
  apps.push(app);
  const post = (payload: Wire = {}, key = "caller-key") =>
    app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: `Bearer ${key}` },
      payload: { model: "m", input: "hello", ...payload },
    });
  return { app, calls, post };
}

function terminal(result: {
  body: string;
  statusCode: number;
  headers: Record<string, unknown>;
}): Wire {
  expect(result.statusCode, result.body).toBe(200);
  if (String(result.headers["content-type"]).includes("application/json"))
    return JSON.parse(result.body) as Wire;
  const event = result.body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as Wire)
    .find((event) => event.type === "response.completed" || event.type === "response.incomplete");
  expect(event, result.body).toBeDefined();
  expect(result.body).toContain("data: [DONE]");
  return event?.response as Wire;
}

function conversation(body: Wire | undefined, protocol: Protocol) {
  expect(body).toBeDefined();
  return (body?.[protocol === "chat" ? "messages" : "input"] as Wire[]).map((item) => ({
    role: item.role,
    text:
      typeof item.content === "string"
        ? item.content
        : (item.content as Wire[]).map((part) => part.text).join(""),
  }));
}

describe("HTTP Responses previous_response_id", () => {
  it.each(
    protocols.flatMap((protocol) => [false, true].map((stream) => ({ protocol, stream }))),
  )("accepts Codex client_metadata without forwarding or retaining it: %j", async ({
    protocol,
    stream,
  }) => {
    const { post, calls } = setup(protocol);
    const first = terminal(
      await post({
        stream,
        client_metadata: {
          turn_id: "private-turn",
          context: { model: "private-model", stream: false },
        },
        metadata: { user_label: "preserved" },
      }),
    );
    expect(calls[0]?.body.metadata).toEqual({ user_label: "preserved" });
    terminal(
      await post({
        stream: !stream,
        previous_response_id: first.id,
        client_metadata: null,
        input: "next",
      }),
    );
    for (const { body } of calls) {
      expect(body.client_metadata).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("private-");
    }
    expect(JSON.stringify(first)).not.toContain("private-");
    expect(conversation(calls[1]?.body, protocol)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "answer 1" },
      { role: "user", text: "next" },
    ]);
  });

  it.each(
    protocols.flatMap((protocol) =>
      [false, true].flatMap((firstStream) =>
        [false, true].map((nextStream) => ({ protocol, firstStream, nextStream })),
      ),
    ),
  )("replays the complete three-turn conversation: %j", async ({
    protocol,
    firstStream,
    nextStream,
  }) => {
    const { post, calls } = setup(protocol);
    const first = terminal(
      await post({ stream: firstStream, store: false, prompt_cache_key: "explicit-key" }),
    );
    const second = terminal(
      await post({
        stream: nextStream,
        store: false,
        previous_response_id: first.id,
        input: "next",
        prompt_cache_key: "explicit-key",
      }),
    );
    terminal(await post({ stream: firstStream, previous_response_id: second.id, input: "last" }));
    expect(conversation(calls[1]?.body, protocol)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "answer 1" },
      { role: "user", text: "next" },
    ]);
    expect(conversation(calls[2]?.body, protocol)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "answer 1" },
      { role: "user", text: "next" },
      { role: "assistant", text: "answer 2" },
      { role: "user", text: "last" },
    ]);
    expect(
      calls.every(
        ({ body, authorization }) =>
          body.previous_response_id === undefined && authorization === "Bearer caller-key",
      ),
    ).toBe(true);
    expect(calls[1]?.body).toMatchObject({ store: false, prompt_cache_key: "explicit-key" });
  });

  it.each(
    protocols,
  )("retains input system messages but not prior turn parameters on %s", async (protocol) => {
    const { post, calls } = setup(protocol);
    const first = terminal(
      await post({
        input: [
          { role: "developer", content: "permanent context" },
          { role: "user", content: "hello" },
        ],
        instructions: "old instructions",
        temperature: 0.4,
        metadata: { private: "old" },
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }),
    );
    terminal(
      await post({
        previous_response_id: first.id,
        instructions: "new instructions",
        input: "next",
      }),
    );
    const body = calls[1]?.body as Wire;
    expect(JSON.stringify(body)).not.toContain("old instructions");
    expect(JSON.stringify(body)).toContain("new instructions");
    expect(JSON.stringify(body)).toContain("permanent context");
    expect(body.temperature).toBeUndefined();
    expect(body.metadata).toBeUndefined();
    expect(body.tools).toBeUndefined();
    terminal(await post({ previous_response_id: first.id, input: "fork" }));
    expect(JSON.stringify(calls[2]?.body)).not.toContain("instructions");
  });

  it.each(
    protocols.flatMap((protocol) => [false, true].map((stream) => ({ protocol, stream }))),
  )("replays client function calls before incremental tool results: %j", async ({
    protocol,
    stream,
  }) => {
    const { post, calls } = setup(protocol, {}, (round, body) =>
      answer(protocol, round, body.stream === true, { tool: round === 1 }),
    );
    const tools = [
      {
        type: "function",
        name: "lookup",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const first = terminal(await post({ stream, tools }));
    terminal(
      await post({
        stream: !stream,
        previous_response_id: first.id,
        tools,
        input: [{ type: "function_call_output", call_id: "call_1", output: "lookup result" }],
      }),
    );
    const items = calls[1]?.body[protocol === "chat" ? "messages" : "input"] as Wire[];
    if (protocol === "chat") {
      expect(items[1]).toMatchObject({
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"hello"}' },
          },
        ],
      });
      expect(items[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "lookup result" });
    } else {
      expect(items[1]).toMatchObject({
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: '{"q":"hello"}',
      });
      expect(items[2]).toEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: "lookup result",
      });
    }
  });

  it.each([
    undefined,
    false,
    true,
    null,
  ])("does not change the HTTP store option: %s", async (store) => {
    const { post, calls } = setup("responses");
    const first = terminal(await post({ store }));
    terminal(await post({ previous_response_id: first.id, input: "next", store }));
    expect(calls.map(({ body }) => body.store)).toEqual([
      store ?? (store === null ? null : false),
      store ?? (store === null ? null : false),
    ]);
  });

  it("allows independent concurrent forks and fresh null or omitted IDs", async () => {
    const { post, calls } = setup();
    const first = terminal(await post());
    const forks = await Promise.all(
      ["branch-a", "branch-b"].map((input) => post({ previous_response_id: first.id, input })),
    );
    const children = forks.map(terminal);
    expect(conversation(calls[1]?.body, "chat").at(-1)?.text).toBe("branch-a");
    expect(conversation(calls[2]?.body, "chat").at(-1)?.text).toBe("branch-b");
    terminal(await post({ previous_response_id: children[0]?.id, input: "continue-a" }));
    expect(JSON.stringify(calls[3]?.body)).toContain("branch-a");
    expect(JSON.stringify(calls[3]?.body)).not.toContain("branch-b");
    for (const previous_response_id of [null, undefined]) {
      terminal(await post({ previous_response_id, input: "fresh" }));
      expect(conversation(calls.at(-1)?.body, "chat")).toEqual([{ role: "user", text: "fresh" }]);
    }
  });

  it("rejects unknown IDs and isolates cached history by credential, model and app", async () => {
    const { post, calls } = setup();
    const first = terminal(await post());
    const results = [
      await post({ previous_response_id: "missing" }),
      await post({ previous_response_id: first.id }, "other-key"),
      await post({ previous_response_id: first.id, model: "other-model" }),
      await setup().post({ previous_response_id: first.id }),
    ];
    for (const result of results) {
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({
        error: {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          param: "previous_response_id",
        },
      });
      expect(result.body).not.toContain("hello");
    }
    expect(calls).toHaveLength(1);
    terminal(await post({ previous_response_id: first.id, input: "still usable" }));
  });

  it("expires parents at configured TTL without losing surviving descendant history", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { post, calls } = setup("chat", { RESPONSES_HISTORY_TTL_MS: "100" });
    const first = terminal(await post());
    now = 50;
    const second = terminal(await post({ previous_response_id: first.id, input: "next" }));
    now = 100;
    expect((await post({ previous_response_id: first.id })).json().error.code).toBe(
      "previous_response_not_found",
    );
    terminal(await post({ previous_response_id: second.id, input: "last" }));
    expect(conversation(calls[2]?.body, "chat")).toHaveLength(5);
    now = 150;
    expect((await post({ previous_response_id: second.id })).statusCode).toBe(400);
  });

  it("enforces history capacity without truncating successful responses", async () => {
    const { post } = setup("chat", { RESPONSES_HISTORY_MAX_CREDENTIAL_BYTES: "1" });
    const first = terminal(await post());
    expect(first.output).toMatchObject([{ content: [{ text: "answer 1" }] }]);
    expect((await post({ previous_response_id: first.id })).json().error.code).toBe(
      "previous_response_not_found",
    );
  });

  it("rejects expanded requests beyond the body budget before calling upstream", async () => {
    const { post, calls } = setup("chat", { BODY_LIMIT_BYTES: "1800" });
    const first = terminal(await post({ input: "中".repeat(200) }));
    const result = await post({ previous_response_id: first.id, input: "文".repeat(400) });
    expect(result.statusCode).toBe(413);
    expect(result.json()).toMatchObject({ error: { code: "request_too_large", param: "input" } });
    expect(calls).toHaveLength(1);
    terminal(await post({ previous_response_id: first.id, input: "small retry" }));
  });

  it.each(
    protocols.flatMap((protocol) => [false, true].map((stream) => ({ protocol, stream }))),
  )("does not save incomplete outputs: %j", async ({ protocol, stream }) => {
    const { post, calls } = setup(protocol, {}, (round, body) => {
      if (round > 1)
        return Response.json({ error: { message: "upstream cannot resolve ID" } }, { status: 404 });
      return answer(protocol, round, body.stream === true, { incomplete: true });
    });
    const first = terminal(await post({ stream }));
    expect(first.status).toBe("incomplete");
    const result = await post({ previous_response_id: first.id, input: "next" });
    expect(result.statusCode).not.toBe(200);
    expect(calls).toHaveLength(protocol === "chat" ? 1 : 2);
    if (protocol === "responses") expect(calls[1]?.body.previous_response_id).toBe(first.id);
  });

  it("keeps a successful parent usable after a failed continuation", async () => {
    const { post, calls } = setup("chat", {}, (round, body) =>
      round === 2
        ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
        : answer("chat", round, body.stream === true),
    );
    const first = terminal(await post());
    expect((await post({ previous_response_id: first.id, input: "failed fork" })).statusCode).toBe(
      429,
    );
    terminal(await post({ previous_response_id: first.id, input: "retry fork" }));
    expect(conversation(calls[2]?.body, "chat")).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "answer 1" },
      { role: "user", text: "retry fork" },
    ]);
  });

  it("does not cache a stream that lacks a validated terminal event", async () => {
    const { post, calls } = setup("responses", {}, async (round, body) => {
      if (round > 1) return answer("responses", round, body.stream === true);
      const response = (await answer("responses", 1, false).json()) as Wire;
      return new Response(responsesFrames(response).slice(0, -2).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const result = await post({ stream: true });
    expect(result.body).toContain("event: error");
    expect(result.body).not.toContain("event: response.completed");
    terminal(await post({ previous_response_id: "resp_1", input: "next" }));
    expect(calls[1]?.body.previous_response_id).toBe("resp_1");
    expect(conversation(calls[1]?.body, "responses")).toEqual([{ role: "user", text: "next" }]);
  });

  it("preserves native upstream continuations without caching partial ancestry", async () => {
    const { post, calls } = setup("responses");
    const first = terminal(
      await post({ previous_response_id: "external_id", input: "second turn", store: true }),
    );
    const next = terminal(
      await post({
        previous_response_id: first.id,
        input: "third turn",
        store: true,
        stream: true,
      }),
    );
    terminal(await post({ previous_response_id: next.id, input: "fourth turn", store: true }));
    expect(calls.map(({ body }) => body.previous_response_id)).toEqual([
      "external_id",
      first.id,
      next.id,
    ]);
    expect(conversation(calls[2]?.body, "responses")).toEqual([
      { role: "user", text: "fourth turn" },
    ]);
  });

  it.each([
    false,
    true,
  ])("retains native encrypted reasoning for continuation: stream=%s", async (stream) => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "opaque-context",
    };
    const { post, calls } = setup("responses", {}, async (round, body) => {
      const response = (await answer("responses", round, false).json()) as Wire;
      if (round === 1) (response.output as Wire[]).unshift(reasoning);
      return body.stream ? responsesStream(response) : Response.json(response);
    });
    const first = terminal(await post({ stream, include: ["reasoning.encrypted_content"] }));
    terminal(await post({ previous_response_id: first.id, input: "next" }));
    expect(calls[1]?.body.input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        id: "rs_1",
        encrypted_content: "opaque-context",
      }),
    );
    expect(calls[1]?.body.previous_response_id).toBeUndefined();
  });

  it("aborts a disconnected HTTP stream without saving partial response history", async () => {
    let cancelled = false;
    const { app, post, calls } = setup("responses", {}, (round, body) => {
      if (round > 1) return answer("responses", round, body.stream === true);
      return new Response(
        new ReadableStream({
          start(controller) {
            const event = {
              type: "response.created",
              sequence_number: 0,
              response: { id: "resp_cancelled", model: "m" },
            };
            controller.enqueue(
              new TextEncoder().encode(
                `event: response.created\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    try {
      const result = await fetch(`${address}/v1/responses`, {
        method: "POST",
        signal: abort.signal,
        headers: { "content-type": "application/json", authorization: "Bearer caller-key" },
        body: JSON.stringify({ model: "m", input: "hello", stream: true }),
      });
      const reader = result.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("response.created");
      abort.abort();
      await reader?.cancel().catch(() => {});
      await vi.waitFor(() => {
        expect(calls[0]?.signal.aborted).toBe(true);
        expect(cancelled).toBe(true);
      });
      terminal(await post({ previous_response_id: "resp_cancelled", input: "next" }));
      expect(calls[1]?.body.previous_response_id).toBe("resp_cancelled");
    } finally {
      abort.abort();
    }
  });

  it("resolves item references before saving history so later turns need no item cache", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { post, calls } = setup();
    const first = terminal(await post());
    now = 200_000;
    const second = terminal(
      await post({
        input: [
          { type: "item_reference", id: (first.output as Wire[])[0]?.id },
          { role: "user", content: "reference input" },
        ],
      }),
    );
    now = 300_001;
    terminal(await post({ previous_response_id: second.id, input: "next" }));
    expect(conversation(calls[2]?.body, "chat")).toEqual([
      { role: "assistant", text: "answer 1" },
      { role: "user", text: "reference input" },
      { role: "assistant", text: "answer 2" },
      { role: "user", text: "next" },
    ]);
    expect(JSON.stringify(calls[2]?.body)).not.toContain("item_reference");
  });

  it("supports JSON and SSE continuation rounds using the official OpenAI SDK", async () => {
    const { app, calls } = setup();
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new OpenAI({ baseURL: `${address}/v1`, apiKey: "caller-key", maxRetries: 0 });
    const first = await client.responses.create({ model: "m", input: "SDK first", store: false });
    const stream = await client.responses.create({
      model: "m",
      previous_response_id: first.id,
      input: "SDK next",
      store: false,
      stream: true,
    });
    const completed: string[] = [];
    for await (const event of stream)
      if (event.type === "response.completed") completed.push(event.response.id);
    expect(completed).toHaveLength(1);
    await client.responses.create({
      model: "m",
      previous_response_id: completed[0] as string,
      input: "SDK third",
    });
    expect(conversation(calls[2]?.body, "chat")).toHaveLength(5);
  });
});
