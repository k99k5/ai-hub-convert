import { describe, expect, it } from "vitest";
import type { WebSearchTool } from "../../src/core/ir.js";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { ResponsesStreamDecoder } from "../../src/protocols/openai-responses/stream-decode.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME as name } from "../../src/providers/web-search/internal.js";
import type { WebSearchProvider, WebSearchRequest } from "../../src/providers/web-search/types.js";
import { UpstreamClient } from "../../src/upstream/client.js";
import { getWebSearchExecutions } from "../../src/upstream/web-search-loop.js";
import { chatStream, collect, responsesFrames, responsesStream } from "../helpers/upstream.js";

const signal = () => new AbortController().signal;
const tool: WebSearchTool = {
  type: "web_search",
  provider: "web-search",
  version: "web_search_20250305",
};
const body = {
  model: "m",
  input: [],
  stream: false,
  tools: [{ type: "function", name, parameters: { type: "object" } }],
};
const searchResult = {
  title: "Example",
  url: "https://docs.example.com/page",
  content: "A useful result",
};
const provider: WebSearchProvider = {
  capabilities: () => ({ execute: true, citations: false, streaming: false }),
  execute: async () => [searchResult],
};
const search = (ids = ["call_search"]) => ({
  id: "resp_search",
  model: "m",
  status: "completed",
  output: ids.map((id) => ({
    id: `fc_${id}`,
    type: "function_call",
    status: "completed",
    call_id: id,
    name,
    arguments: JSON.stringify({ query: "documentation" }),
  })),
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
});
const answer = {
  id: "resp_answer",
  model: "m",
  status: "completed",
  output: [
    {
      id: "msg_answer",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 200,
    output_tokens: 20,
    total_tokens: 220,
    input_tokens_details: { cached_tokens: 30 },
    output_tokens_details: { reasoning_tokens: 4 },
  },
};

function client(fetch: typeof globalThis.fetch, webSearchProvider = provider, timeoutMs = 1000) {
  return new UpstreamClient({
    baseUrl: new URL("https://upstream.test/v1/"),
    timeoutMs,
    fetch,
    webSearchProvider,
  });
}

function waitForAbort(abortSignal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (abortSignal.aborted) reject(abortSignal.reason);
    else abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
  });
}

describe("protocol review regressions", () => {
  it("keeps the tool argument budget across internal search rounds", async () => {
    let calls = 0;
    const upstream = client(async () => responsesStream(search([`call_${++calls}`])));
    await expect(
      collect(
        upstream.streamCompletion("responses", body, "key", signal(), {
          argumentLimits: { perCallBytes: 30, perStreamBytes: 40 },
        }),
      ),
    ).rejects.toMatchObject({ scope: "stream" });
    expect(calls).toBe(2);
  });

  it("bounds retained search results before another model round starts", async () => {
    let calls = 0;
    const upstream = client(
      async () => {
        calls++;
        return responsesStream(search());
      },
      {
        ...provider,
        execute: async () => [{ ...searchResult, content: "x".repeat(2000) }],
      },
    );
    await expect(
      collect(
        upstream.streamCompletion("responses", body, "key", signal(), {
          outputLimits: { perItemBytes: 1000, perStreamBytes: 1000 },
        }),
      ),
    ).rejects.toMatchObject({ scope: "stream" });
    expect(calls).toBe(1);
  });

  it("does not silently turn invalid upstream usage into zero during aggregation", async () => {
    await expect(
      client(async () =>
        Response.json({ ...search(), usage: { input_tokens: -1, output_tokens: 1 } }),
      ).postJson("responses", body, "key", signal()),
    ).rejects.toThrow(/Invalid upstream token usage/);
  });

  it("replays a response's assistant text and refusal as conversation input", () => {
    const decoded = decodeResponsesRequest({
      model: "m",
      input: [
        ...answer.output,
        { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "cannot" }] },
        { role: "user", content: "continue" },
      ],
    });
    const encoded = encodeResponsesRequest(decoded, {
      store: false,
      promptCache: { kind: "none" },
    });
    expect(encoded.input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "answer" }] },
      { type: "message", role: "assistant", content: [{ type: "input_text", text: "cannot" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    ]);
    expect(() =>
      decodeResponsesRequest({
        model: "m",
        input: [{ role: "user", content: answer.output[0]?.content }],
      }),
    ).toThrow();
  });

  it("preserves both protocols' domain filters and Anthropic max_uses", () => {
    const anthropic = decodeAnthropicRequest({
      model: "m",
      max_tokens: 20,
      messages: [],
      tools: [
        {
          type: tool.version,
          name: "web_search",
          max_uses: 1,
          allowed_domains: ["example.com"],
        },
      ],
    });
    expect(anthropic.tools[0]).toEqual({ ...tool, maxUses: 1, allowedDomains: ["example.com"] });
    expect(
      decodeResponsesRequest({
        model: "m",
        tools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }],
      }).tools[0],
    ).toMatchObject({ allowedDomains: ["example.com"] });
  });

  it.each([-1, 1.5])("rejects an invalid search limit %s", (maxUses) => {
    expect(() =>
      decodeAnthropicRequest({
        model: "m",
        max_tokens: 20,
        messages: [],
        tools: [{ type: tool.version, name: "web_search", max_uses: maxUses }],
      }),
    ).toThrow();
  });

  it("accepts standard refusal delta/done frames without duplicating the text", async () => {
    const refused = {
      ...answer,
      output: [
        {
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot help" }],
        },
      ],
    };
    const events = await collect(
      client(async () => responsesStream(refused)).streamCompletion(
        "responses",
        {},
        "key",
        signal(),
      ),
    );
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", index: 0, delta: "I cannot help" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "response_complete", finishReason: "refusal" });
  });

  it("rejects refusal content that changes between deltas and the done item", () => {
    const decoder = new ResponsesStreamDecoder();
    const decode = (type: string, fields: Record<string, unknown>) =>
      decoder.decode({ event: type, data: JSON.stringify({ type, ...fields }) });
    decode("response.created", { response: { id: "resp", model: "m" } });
    decode("response.output_item.added", {
      output_index: 0,
      item: { id: "msg", type: "message", role: "assistant", content: [] },
    });
    decode("response.refusal.delta", { output_index: 0, item_id: "msg", delta: "original" });
    expect(() =>
      decode("response.output_item.done", {
        output_index: 0,
        item: {
          id: "msg",
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "changed" }],
        },
      }),
    ).toThrow(/refusal does not match/);
  });

  it.each([
    false,
    true,
  ])("enforces max_uses across parallel calls for stream=%s", async (stream) => {
    const requests: WebSearchRequest[] = [];
    const upstreamBodies: Record<string, unknown>[] = [];
    const upstream = client(
      async (_url, init) => {
        upstreamBodies.push(JSON.parse(init?.body as string));
        const response = upstreamBodies.length === 1 ? search(["a", "b"]) : answer;
        return stream ? responsesStream(response) : Response.json(response);
      },
      {
        ...provider,
        execute: async (request) => {
          requests.push(request);
          return [searchResult];
        },
      },
    );
    if (stream) {
      const events = await collect(
        upstream.streamCompletion("responses", body, "key", signal(), {
          webSearch: { ...tool, maxUses: 1 },
        }),
      );
      expect(events.at(-1)).toMatchObject({ usage: { webSearchRequests: 1 } });
    } else {
      const response = await upstream.postJson("responses", body, "key", signal(), {
        ...tool,
        maxUses: 1,
      });
      expect(response).toMatchObject({ usage: { server_tool_use: { web_search_requests: 1 } } });
    }
    expect(requests).toHaveLength(1);
    expect(upstreamBodies[1]?.tools).toEqual([]);
    expect(JSON.stringify(upstreamBodies[1]?.input)).toContain("max_uses_exceeded");
  });

  it("removes search before the first request when max_uses is zero", async () => {
    let sent: Record<string, unknown> = {};
    await client(async (_url, init) => {
      sent = JSON.parse(init?.body as string);
      return Response.json(answer);
    }).postJson("responses", { ...body, tool_choice: "required" }, "key", signal(), {
      ...tool,
      maxUses: 0,
    });
    expect(sent.tools).toEqual([]);
    expect(sent.tool_choice).toBe("auto");
  });

  it.each([
    "allowed",
    "blocked",
  ])("applies %s domain policy even with a custom provider", async (kind) => {
    let round = 0;
    const seen: WebSearchRequest[] = [];
    const outside = { ...searchResult, url: "https://notexample.com/page" };
    const upstream = client(async () => Response.json(++round === 1 ? search() : answer), {
      ...provider,
      execute: async (request) => {
        seen.push(request);
        return [outside, searchResult];
      },
    });
    const policy =
      kind === "allowed"
        ? { allowedDomains: ["example.com"] }
        : { blockedDomains: ["notexample.com"] };
    const result = await upstream.postJson("responses", body, "key", signal(), {
      ...tool,
      ...policy,
    });
    expect(getWebSearchExecutions(result)[0]?.results).toEqual([searchResult]);
    expect(seen[0]).toMatchObject(kind === "allowed" ? { domains: ["example.com"] } : policy);
  });

  it.each([
    false,
    true,
  ])("releases a forced search and aggregates all token details for stream=%s", async (stream) => {
    const sent: Record<string, unknown>[] = [];
    const upstream = client(async (_url, init) => {
      const request = JSON.parse(init?.body as string);
      sent.push(request);
      const response = request.tool_choice?.name === name ? search() : answer;
      return stream ? responsesStream(response) : Response.json(response);
    });
    const request = { ...body, tool_choice: { type: "function", name } };
    if (stream) {
      const events = await collect(
        upstream.streamCompletion("responses", request, "key", signal()),
      );
      expect(events.at(-1)).toMatchObject({
        usage: {
          inputTokens: 300,
          outputTokens: 30,
          cacheReadInputTokens: 50,
          cacheWriteInputTokens: 5,
          reasoningTokens: 7,
          webSearchRequests: 1,
        },
      });
    } else {
      expect(await upstream.postJson("responses", request, "key", signal())).toMatchObject({
        usage: {
          input_tokens: 300,
          output_tokens: 30,
          total_tokens: 330,
          input_tokens_details: { cached_tokens: 50, cache_write_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 7 },
        },
      });
    }
    expect(sent).toHaveLength(2);
    expect(sent[1]?.tool_choice).toBe("auto");
  });

  it.each([
    false,
    true,
  ])("marks HTTP errors after a successful search round ineligible for fallback (stream=%s)", async (stream) => {
    let round = 0;
    const upstream = client(async () => {
      if (++round === 1) return stream ? responsesStream(search()) : Response.json(search());
      return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    });
    const result = stream
      ? collect(upstream.streamCompletion("responses", body, "key", signal()))
      : upstream.postJson("responses", body, "key", signal());
    await expect(result).rejects.toMatchObject({ status: 404, hasUpstreamSemanticEvent: true });
  });

  it("keeps initial endpoint failures eligible for fallback", async () => {
    const upstream = client(async () =>
      Response.json({ error: { code: "route_not_found" } }, { status: 404 }),
    );
    await expect(
      collect(upstream.streamCompletion("responses", body, "key", signal())),
    ).rejects.toMatchObject({ hasUpstreamSemanticEvent: false });
  });

  it.each([
    false,
    true,
  ])("uses one deadline during search execution for stream=%s", async (stream) => {
    let providerSignal: AbortSignal | undefined;
    const upstream = client(
      async () => (stream ? responsesStream(search()) : Response.json(search())),
      {
        ...provider,
        execute: async (_request, context) => {
          providerSignal = context.signal;
          return waitForAbort(context.signal);
        },
      },
      80,
    );
    const result = stream
      ? collect(upstream.streamCompletion("responses", body, "key", signal()))
      : upstream.postJson("responses", body, "key", signal());
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    expect(providerSignal?.aborted).toBe(true);
  });

  it("covers time spent waiting for upstream HTTP headers with the first-byte timeout", async () => {
    const upstream = client(async (_url, init) => waitForAbort(init?.signal as AbortSignal));
    await expect(
      collect(
        upstream.streamCompletion("responses", body, "key", signal(), {
          timeouts: { firstByteTimeoutMs: 30, idleTimeoutMs: 1000 },
        }),
      ),
    ).rejects.toMatchObject({ phase: "first-byte" });
  });

  it("forwards text before the rest of a stream with an unused search tool arrives", async () => {
    const frames = responsesFrames(answer);
    const split =
      frames.findIndex((frame) => frame.includes('"type":"response.output_text.delta"')) + 1;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(new TextEncoder().encode(frames.slice(0, split).join("")));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    let wireStream: unknown;
    const iterator = client(async (_url, init) => {
      wireStream = JSON.parse(init?.body as string).stream;
      return response;
    }).streamCompletion("responses", body, "key", signal());
    expect((await iterator.next()).value?.type).toBe("response_start");
    expect((await iterator.next()).value?.type).toBe("content_start");
    expect((await iterator.next()).value).toMatchObject({ type: "text_delta", delta: "answer" });
    expect(wireStream).toBe(true);
    controller?.enqueue(new TextEncoder().encode(frames.slice(split).join("")));
    controller?.close();
    expect((await collect(iterator)).at(-1)).toMatchObject({ type: "response_complete" });
  });

  it("runs forced Chat searches with streaming tool results and aggregated usage", async () => {
    const sent: Record<string, unknown>[] = [];
    const upstream = client(async (_url, init) => {
      const request = JSON.parse(init?.body as string);
      sent.push(request);
      return chatStream({
        id: `chat_${sent.length}`,
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: sent.length === 1 ? "tool_calls" : "stop",
            message:
              sent.length === 1
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call",
                        type: "function",
                        function: { name, arguments: '{"query":"docs"}' },
                      },
                    ],
                  }
                : { role: "assistant", content: "answer" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    });
    const events = await collect(
      upstream.streamCompletion(
        "chat/completions",
        {
          model: "m",
          messages: [],
          stream: true,
          tools: [{ type: "function", function: { name, parameters: {} } }],
          tool_choice: { type: "function", function: { name } },
        },
        "key",
        signal(),
      ),
    );
    expect(sent[1]?.tool_choice).toBe("auto");
    expect(sent[1]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call" })]),
    );
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 4, webSearchRequests: 1 },
    });
    expect(JSON.stringify(events)).not.toContain(name);
  });
});
