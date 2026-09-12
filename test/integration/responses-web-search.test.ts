import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadResponsesConfig as loadConfig } from "../helpers/config.js";
import { DuckDuckGoWebSearchProvider } from "../../src/providers/web-search/duckduckgo.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { UpstreamClient } from "../../src/upstream/client.js";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { responsesStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const url = "https://example.test/doc";
const answer = `查看[资料](${url})，另有 https://unknown.test/。`;
const resultHtml = `<table>
  <tr><td><a class="result-link" href="${url}">资料</a></td></tr>
  <tr><td class="result-snippet">搜索摘要</td></tr>
  <tr><td><a class="result-link" href="https://blocked.example.test/doc">屏蔽站点</a></td></tr>
  <tr><td class="result-snippet">不可使用</td></tr></table>`;

function modelResponse(search = false): Wire {
  return {
    id: search ? "resp_search" : "resp_answer",
    object: "response",
    model: "model-test",
    status: "completed",
    output: search
      ? [
          {
            id: "fc_search",
            type: "function_call",
            status: "completed",
            call_id: "call_search",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            arguments: '{"query":"资料"}',
          },
        ]
      : [
          {
            id: "msg_answer",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function frames(body: string): Wire[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Wire);
}

describe("Responses 网关搜索 HTTP 闭环", () => {
  it("中文域名与 Punycode 在白名单和黑名单中匹配一致", async () => {
    const html =
      '<a class="result-link" href="https://子域.例子.测试/doc">资料</a><td class="result-snippet">内容</td>';
    const provider = new DuckDuckGoWebSearchProvider(async () => new Response(html));
    const context = { requestId: "search", signal: new AbortController().signal };
    const canonical = decodeResponsesRequest({
      model: "m",
      input: "查询",
      tools: [
        {
          type: "web_search",
          filters: { allowed_domains: ["例子.测试"], blocked_domains: ["例子.测试"] },
        },
      ],
    });
    const tool = canonical.tools[0];
    expect(tool?.type).toBe("web_search");
    if (tool?.type !== "web_search") throw new Error("缺少搜索工具");
    if (!tool.allowedDomains || !tool.blockedDomains) throw new Error("缺少域名过滤参数");
    const results = await provider.execute(
      { query: "查询", domains: tool.allowedDomains },
      context,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://xn--cjsx3f.xn--fsqu00a.xn--0zwm56d/doc");
    expect(
      await provider.execute({ query: "查询", blockedDomains: tool.blockedDomains }, context),
    ).toEqual([]);
    expect(
      await provider.execute(
        { query: "查询", blockedDomains: ["xn--fsqu00a.xn--0zwm56d"] },
        context,
      ),
    ).toEqual([]);
  });
  it.each([
    { size: "low", count: 3 },
    { size: "medium", count: 5 },
    { size: "high", count: 10 },
  ])("上下文大小限制实际回填的搜索结果 %j", async ({ size, count }) => {
    const html = Array.from(
      { length: 12 },
      (_, index) =>
        `<a class="result-link" href="https://example.test/${index}">资料${index}</a><td class="result-snippet">内容</td>`,
    ).join("");
    const bodies: Wire[] = [];
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      webSearchProvider: new DuckDuckGoWebSearchProvider(async () => new Response(html)),
      upstreamFetch: async (_input, init) => {
        bodies.push(JSON.parse(init?.body as string) as Wire);
        return Response.json(modelResponse(bodies.length === 1));
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "model-test",
        input: "查询",
        tools: [{ type: "web_search", search_context_size: size }],
      },
    });
    expect(response.statusCode).toBe(200);
    const result = (bodies[1]?.input as Wire[]).find(
      (item) => item.type === "function_call_output",
    );
    expect(JSON.parse(result?.output as string).results).toHaveLength(count);
  });

  it.each([false, true])("单轮多个搜索调用也不超过 max_tool_calls，stream=%s", async (stream) => {
    const bodies: Wire[] = [];
    const searchFetch = vi.fn(async () => new Response(resultHtml));
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      webSearchProvider: new DuckDuckGoWebSearchProvider(searchFetch),
      upstreamFetch: async (_input, init) => {
        bodies.push(JSON.parse(init?.body as string) as Wire);
        const body = modelResponse(bodies.length === 1);
        if (bodies.length === 1) {
          const output = body.output as Wire[];
          output.push({ ...output[0], id: "fc_other", call_id: "call_other" });
        }
        return stream ? responsesStream(body) : Response.json(body);
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "model-test",
        input: "查询",
        stream,
        tools: [{ type: "web_search" }],
        max_tool_calls: 1,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(searchFetch).toHaveBeenCalledTimes(1);
    const result = stream
      ? (frames(response.body).at(-1)?.response as Wire)
      : response.json<Wire>();
    expect(
      (result.output as Wire[]).filter((item) => item.type === "web_search_call"),
    ).toHaveLength(1);
    const toolResults = (bodies[1]?.input as Wire[]).filter(
      (item) => item.type === "function_call_output",
    );
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(toolResults[1]?.output as string)).toEqual({
      ok: false,
      error: "max_uses_exceeded",
    });
  });

  it.each(
    [false, true].flatMap((stream) => [false, true].map((include) => ({ stream, include }))),
  )("搜索执行、来源引用和历史回放 %j", async ({ stream, include }) => {
    const bodies: Wire[] = [];
    const searchFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(resultHtml));
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      webSearchProvider: new DuckDuckGoWebSearchProvider(searchFetch),
      upstreamFetch: async (input, init) => {
        expect(String(input)).toBe("https://upstream.test/v1/responses");
        const body = JSON.parse(init?.body as string) as Wire;
        bodies.push(body);
        const response = modelResponse(bodies.length === 1);
        return body.stream ? responsesStream(response) : Response.json(response);
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "model-test",
        input: "搜索资料",
        stream,
        tools: [
          {
            type: "web_search",
            external_web_access: true,
            search_context_size: "low",
            user_location: { country: "CN", city: "上海", timezone: "Asia/Shanghai" },
            filters: {
              allowed_domains: ["example.test"],
              blocked_domains: ["blocked.example.test"],
            },
          },
        ],
        tool_choice: { type: "web_search" },
        max_tool_calls: 1,
        include: include ? ["web_search_call.action.sources"] : [],
      },
    });
    expect(response.statusCode).toBe(200);
    const events = stream ? frames(response.body) : [];
    const result = stream ? (events.at(-1)?.response as Wire) : response.json<Wire>();
    const output = result.output as Wire[];
    expect(output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    expect(output[0]).toMatchObject({
      status: "completed",
      action: { query: "资料", queries: ["资料"] },
    });
    if (include) expect(output[0]?.action).toHaveProperty("sources", [{ type: "url", url }]);
    else expect(output[0]?.action).not.toHaveProperty("sources");
    const text = (output[1]?.content as Wire[])[0];
    expect(text?.text).toBe(answer);
    expect(text?.annotations).toEqual([
      { type: "url_citation", url, title: "资料", start_index: 2, end_index: 32 },
    ]);
    expect(result.usage).toMatchObject({ input_tokens: 6, output_tokens: 4, total_tokens: 10 });
    expect(bodies).toHaveLength(2);
    expect(searchFetch).toHaveBeenCalledTimes(1);
    const searchUrl = new URL(String(searchFetch.mock.calls[0]?.[0]));
    expect(searchUrl.searchParams.get("q")).toBe("资料 上海 CN");
    expect(bodies[0]?.tool_choice).toEqual({
      type: "function",
      name: INTERNAL_WEB_SEARCH_TOOL_NAME,
    });
    expect(bodies[1]?.tool_choice).toBe("auto");
    expect(bodies[1]?.tools).toEqual([]);
    expect(JSON.stringify(bodies[1]?.input)).toContain("搜索摘要");
    expect(JSON.stringify(bodies[1]?.input)).not.toContain("不可使用");
    expect(JSON.stringify(bodies)).not.toContain("web_search_call.action.sources");
    expect(JSON.stringify(result)).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
    if (stream) {
      expect(events.filter((event) => event.type === "response.created")).toHaveLength(1);
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
      expect(
        events
          .filter((event) => event.type === "response.output_item.done")
          .map((event) => event.item),
      ).toEqual(output);
      expect(
        events
          .filter((event) => String(event.type).startsWith("response.web_search_call."))
          .map((event) => event.type),
      ).toEqual([
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
      ]);
    }
    const replay = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer test-key" },
      payload: { model: "model-test", input: [...output, { role: "user", content: "继续" }] },
    });
    expect(replay.statusCode).toBe(200);
    expect(searchFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(bodies[2]?.input)).toContain("历史网页搜索记录");
    expect(JSON.stringify(bodies[2]?.input)).not.toContain('"type":"web_search_call"');
    expect(JSON.stringify(bodies[2]?.input)).toContain("继续");
  });

  it.each([false, true])("空搜索结果保留搜索项且无虚构引用，stream=%s", async (stream) => {
    let calls = 0;
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      webSearchProvider: new DuckDuckGoWebSearchProvider(
        async () => new Response("拒绝", { status: 429 }),
      ),
      upstreamFetch: async () => {
        const body = modelResponse(calls++ === 0);
        return stream ? responsesStream(body) : Response.json(body);
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "model-test",
        input: "搜索",
        stream,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = stream ? (frames(response.body).at(-1)?.response as Wire) : response.json<Wire>();
    const output = body.output as Wire[];
    expect(output[0]?.action).toHaveProperty("sources", []);
    expect((output[1]?.content as Wire[])[0]?.annotations).toEqual([]);
  });

  it("不支持的离线和图片语义在发起任何网络请求前拒绝", async () => {
    const fetch = vi.fn(async () => Response.json(modelResponse()));
    const app = buildApp({
      config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
      logger: false,
      upstreamFetch: fetch,
      webSearchProvider: new DuckDuckGoWebSearchProvider(fetch),
    });
    apps.push(app);
    for (const tool of [
      { type: "web_search", external_web_access: false },
      { type: "web_search_preview", search_content_types: ["image"] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer test-key" },
        payload: { model: "model-test", input: "搜索", tools: [tool] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("搜索期间的事件与取消", () => {
  it("搜索结果未返回时先发送进度，取消后不继续请求模型", async () => {
    const providerStarted = Promise.withResolvers<void>();
    let calls = 0;
    const controller = new AbortController();
    const client = new UpstreamClient({
      baseUrl: new URL("https://upstream.test/v1/"),
      timeoutMs: 1000,
      fetch: async () => {
        calls++;
        return responsesStream(modelResponse(true));
      },
      webSearchProvider: {
        capabilities: () => ({ execute: true, citations: false, streaming: false }),
        execute: async (_request, context) => {
          providerStarted.resolve();
          return new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      },
    });
    const events = client.streamCompletion(
      "responses",
      {
        model: "m",
        input: [],
        tools: [{ type: "function", name: INTERNAL_WEB_SEARCH_TOOL_NAME, parameters: {} }],
      },
      "key",
      controller.signal,
    );
    const encoder = new ResponsesStreamEncoder();
    const sent: string[] = [];
    while (!sent.includes("response.web_search_call.searching")) {
      const step = await events.next();
      expect(step.done).toBe(false);
      if (!step.done) sent.push(...encoder.encode(step.value).map((frame) => frame.event));
    }
    expect(sent).not.toContain("response.web_search_call.completed");
    const next = events.next();
    const rejection = expect(next).rejects.toThrow("取消搜索");
    await providerStarted.promise;
    controller.abort(new Error("取消搜索"));
    await rejection;
    expect(calls).toBe(1);
  });
});
