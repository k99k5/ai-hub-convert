import { describe, expect, it, vi } from "vitest";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";
import {
  addResponsesWebSearch,
  decodeWebSearchHistory,
  encodeWebSearchCall,
  webSearchCitations as iterateWebSearchCitations,
} from "../../src/protocols/openai-responses/web-search.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { StreamOutputLimitError } from "../../src/stream/output-limits.js";
import type { CanonicalEvent } from "../../src/core/events.js";
import type { Citation } from "../../src/core/ir.js";

const source = { title: "资料", url: "https://example.test/doc", content: "内容" };
const search = { id: "call_search", query: "资料", results: [source] };
const completion = {
  type: "response_complete",
  finishReason: "end_turn",
  usage: { inputTokens: 3, outputTokens: 2 },
} as const;
const encodeOptions = { store: false, promptCache: { kind: "none" } } as const;

function webSearchCitations(...args: Parameters<typeof iterateWebSearchCitations>) {
  return [...iterateWebSearchCitations(...args)];
}

function request(fields: Record<string, unknown> = {}) {
  return decodeResponsesRequest({
    model: "model-test",
    input: "搜索",
    tools: [{ type: "web_search" }],
    ...fields,
  });
}

describe("Responses 网关搜索请求", () => {
  it.each([
    "web_search",
    "web_search_2025_08_26",
    "web_search_preview",
    "web_search_preview_2025_03_11",
  ])("支持工具版本和显式选择 %s", (type) => {
    const canonical = request({ tools: [{ type }], tool_choice: { type } });
    expect(encodeResponsesRequest(canonical, encodeOptions).tool_choice).toEqual({
      type: "function",
      name: INTERNAL_WEB_SEARCH_TOOL_NAME,
    });
  });

  it("传递可实现的参数并只把推理 include 发给上游", () => {
    const canonical = request({
      tools: [
        {
          type: "web_search",
          search_context_size: "high",
          external_web_access: true,
          filters: { allowed_domains: ["example.test"], blocked_domains: ["blocked.example.test"] },
          user_location: {
            type: "approximate",
            country: "CN",
            city: "上海",
            timezone: "Asia/Shanghai",
          },
        },
      ],
      max_tool_calls: 2,
      include: ["web_search_call.action.sources", "reasoning.encrypted_content"],
    });
    expect(canonical.tools[0]).toMatchObject({
      maxUses: 2,
      searchContextSize: "high",
      allowedDomains: ["example.test"],
      blockedDomains: ["blocked.example.test"],
      userLocation: { country: "CN", city: "上海", timezone: "Asia/Shanghai" },
    });
    const encoded = encodeResponsesRequest(canonical, {
      ...encodeOptions,
      replaySourceExtensions: true,
    });
    expect(encoded.include).toEqual(["reasoning.encrypted_content"]);
    expect(encoded.tools?.[0]?.description).toContain("Asia/Shanghai");
  });

  it("普通同名函数和内置搜索分别选择", () => {
    const tools = [
      { type: "web_search" },
      { type: "function", name: "web_search", parameters: {} },
    ];
    for (const [choice, name] of [
      [{ type: "function", name: "web_search" }, "web_search"],
      [{ type: "web_search" }, INTERNAL_WEB_SEARCH_TOOL_NAME],
    ] as const) {
      expect(
        encodeResponsesRequest(request({ tools, tool_choice: choice }), encodeOptions).tool_choice,
      ).toEqual({ type: "function", name });
    }
  });

  it.each(["auto", "required"])("allowed_tools 约束实际可用工具，模式 %s", (mode) => {
    const canonical = request({
      tools: [{ type: "web_search" }, { type: "function", name: "weather", parameters: {} }],
      tool_choice: { type: "allowed_tools", mode, tools: [{ type: "web_search" }] },
    });
    expect(canonical.tools).toHaveLength(1);
    expect(canonical.toolChoice).toEqual({ type: mode });
  });

  it.each([
    { tools: [{ type: "web_search", external_web_access: false }] },
    { tools: [{ type: "web_search", external_web_access: "true" }] },
    { tools: [{ type: "web_search_preview", search_content_types: ["image"] }] },
    { tools: [{ type: "web_search" }, { type: "web_search_preview" }] },
    { tools: [{ type: "function", name: INTERNAL_WEB_SEARCH_TOOL_NAME, parameters: {} }] },
    { tools: [{ type: "web_search", filters: { allowed_domains: [""] } }] },
    { tools: [{ type: "web_search", filters: { blocked_domains: ["https://example.test"] } }] },
    {
      tools: [
        { type: "web_search", filters: { allowed_domains: Array(101).fill("example.test") } },
      ],
    },
    { tools: [{ type: "web_search", filters: { unsupported: true } }] },
    { include: ["unknown"] },
    { include: "web_search_call.action.sources" },
    { max_tool_calls: 0 },
    { max_tool_calls: -1 },
    { max_tool_calls: 1.2 },
    { tool_choice: { type: "function", name: "missing" } },
    { tool_choice: { type: "allowed_tools", mode: "none", tools: [{ type: "web_search" }] } },
    { tool_choice: { type: "allowed_tools", mode: "auto", tools: [] } },
  ])("拒绝无效或无法实现的参数 %j", (fields) => {
    expect(() => request(fields)).toThrow();
  });
});

describe("Responses 搜索引用和历史", () => {
  it.each(
    [".", ",", ";", ":", "!", "?", "。"].flatMap((punctuation) =>
      [false, true].map((withTitle) => ({ punctuation, withTitle })),
    ),
  )("显式链接保留末尾标点且裸链接优先匹配完整来源 %j", ({ punctuation, withTitle }) => {
    const url = source.url + punctuation;
    const text = `[资料](${url}${withTitle ? ' "标题"' : ""})`;
    expect(webSearchCitations(text, [source])).toEqual([]);
    const citations = webSearchCitations(text, [{ ...source, url }]);
    expect(citations).toEqual([
      { type: "url", url, title: source.title, startIndex: 0, endIndex: text.length },
    ]);
    expect(webSearchCitations(url, [source, { ...source, url }])).toMatchObject([
      { url, endIndex: url.length },
    ]);
  });
  it("引用扩张逐条检查限额，不序列化完整超大结果", () => {
    const serialize = JSON.stringify.bind(JSON);
    let largestSerialization = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
      const result = serialize(value);
      largestSerialization = Math.max(largestSerialization, result?.length ?? 0);
      return result;
    });
    try {
      expect(() =>
        addResponsesWebSearch(
          {
            id: "r",
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: `${source.url} `.repeat(1000),
                    annotations: [],
                  },
                ],
              },
            ],
          },
          [{ ...search, results: [{ ...source, title: "x".repeat(20_000) }] }],
          false,
          { perItemBytes: 100_000, perStreamBytes: 200_000 },
        ),
      ).toThrow(StreamOutputLimitError);
      expect(largestSerialization).toBeLessThan(100_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("已有的两万条引用只建立一次索引", () => {
    let urlReads = 0;
    const existing: Citation[] = Array.from({ length: 20_000 }, (_, index) => ({
      type: "url",
      get url() {
        urlReads++;
        return source.url;
      },
      startIndex: index * (source.url.length + 1),
      endIndex: index * (source.url.length + 1) + source.url.length,
    }));
    expect(
      webSearchCitations(`${source.url} `.repeat(existing.length), [source], existing),
    ).toEqual([]);
    expect(urlReads).toBe(existing.length);
  });

  it("括号是 URL 的一部分，不能截取已知来源前缀", () => {
    expect(webSearchCitations(`${source.url}(different-page)`, [source])).toEqual([]);
    expect(webSearchCitations(`${source.url}[different-page]`, [source])).toEqual([]);
    const url = "https://example.test/Java_(programming_language)";
    for (const text of [
      url,
      `[资料](${url})`,
      `[资料](${url} "标题")`,
      `[资料](${url.replaceAll("(", "\\(").replaceAll(")", "\\)")})`,
      `(${url})`,
    ]) {
      const citations = webSearchCitations(text, [{ ...source, url }]);
      expect(citations).toHaveLength(1);
      expect(citations[0]?.url).toBe(url);
      expect(citations[0]?.endIndex).toBeLessThanOrEqual(text.length);
    }
  });
  it("引用仅匹配真实来源的完整链接，支持中文、分块后的链接和去重", () => {
    const text = `中文😀 [资料](${source.url})；${source.url}. https://example.test/document https://other.test`;
    const citations = webSearchCitations(text, [source, source]);
    expect(citations).toHaveLength(2);
    for (const citation of citations) {
      expect(text.slice(citation.startIndex, citation.endIndex)).toContain(source.url);
    }
    expect(webSearchCitations(text, [source], citations)).toEqual([]);
    expect(webSearchCitations("未引用链接", [source])).toEqual([]);
    expect(webSearchCitations("[".repeat(100_000), [source])).toEqual([]);
  });

  it.each([true, false])("JSON 来源开关和搜索项回传，include=%s", (include) => {
    const response = addResponsesWebSearch(
      {
        id: "resp",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `[资料](${source.url})`, annotations: [] }],
          },
        ],
      },
      [search],
      include,
    );
    const output = response.output as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "资料", queries: ["资料"] },
    });
    expect(output[0]?.action).toEqual(
      expect.objectContaining(
        include ? { sources: [{ type: "url", url: source.url }] } : { type: "search" },
      ),
    );
    if (!include) expect(output[0]?.action).not.toHaveProperty("sources");
    const canonical = request({ input: [...output, { role: "user", content: "继续" }], tools: [] });
    const encoded = encodeResponsesRequest(canonical, encodeOptions);
    expect(JSON.stringify(encoded.input)).not.toContain('"type":"web_search_call"');
    expect(JSON.stringify(encoded.input)).toContain("历史网页搜索记录");
    expect(JSON.stringify(encoded.input)).toContain(source.url);
  });

  it.each([
    { type: "search", queries: ["查询"], sources: [{ type: "url", url: source.url }] },
    { type: "open_page", url: source.url },
    { type: "find_in_page", url: source.url, pattern: "内容" },
  ])("接受原生历史动作而不重新执行 %j", (action) => {
    expect(
      decodeWebSearchHistory({
        id: "ws_upstream",
        type: "web_search_call",
        status: "completed",
        action,
      }).role,
    ).toBe("assistant");
  });

  it.each([
    { type: "unknown" },
    { type: "search", queries: "错误" },
    { type: "search", sources: [{ type: "url", url: "javascript:alert(1)" }] },
    { type: "find_in_page", url: source.url },
    { type: "open_page", url: 1 },
  ])("拒绝畸形搜索历史 %j", (action) => {
    expect(() => decodeWebSearchHistory({ id: "ws", status: "completed", action })).toThrow();
  });

  it("搜索输出 JSON 转义后仍受限额约束", () => {
    expect(() =>
      addResponsesWebSearch(
        { id: "r", output: [] },
        [{ ...search, query: "\u0001".repeat(100) }],
        true,
        { perItemBytes: 400, perStreamBytes: 1000 },
      ),
    ).toThrow(StreamOutputLimitError);
  });
});

describe("Responses 搜索流式编码", () => {
  it("混合文本、重复调用 ID 和多轮搜索时，索引和终态保持一致", () => {
    const encoder = new ResponsesStreamEncoder(undefined, undefined, {
      includeWebSearchSources: true,
    });
    const events: CanonicalEvent[] = [
      { type: "response_start", id: "r", model: "m" },
      { type: "content_start", index: 0, itemId: "before", content: { type: "text", text: "" } },
      { type: "text_delta", index: 0, delta: "开始" },
      { type: "content_stop", index: 0 },
      { type: "web_search_start", id: search.id, query: search.query },
      { type: "web_search_result", execution: search },
      { type: "web_search_start", id: search.id, query: search.query },
      { type: "web_search_result", execution: { ...search, results: [] } },
      { type: "content_start", index: 1, itemId: "answer", content: { type: "text", text: "" } },
      { type: "text_delta", index: 1, delta: `[资料](https://exam` },
      { type: "text_delta", index: 1, delta: "ple.test/doc)" },
      { type: "content_stop", index: 1 },
      completion,
    ];
    const frames = events.flatMap((event) => encoder.encode(event));
    expect(frames.map((frame) => frame.data.sequence_number)).toEqual(
      frames.map((_, index) => index),
    );
    const added = frames.filter((frame) => frame.event === "response.output_item.added");
    expect(added.map((frame) => frame.data.output_index)).toEqual([0, 1, 2, 3]);
    const done = frames
      .filter((frame) => frame.event === "response.output_item.done")
      .map((frame) => frame.data.item);
    expect((frames.at(-1)?.data.response as { output: unknown[] }).output).toEqual(done);
    expect(new Set(done.map((item) => (item as { id: string }).id)).size).toBe(4);
    const annotations = frames.filter(
      (frame) => frame.event === "response.output_text.annotation.added",
    );
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.data).toMatchObject({
      output_index: 3,
      item_id: "answer",
      annotation: { url: source.url, start_index: 0, end_index: 30 },
    });
    expect(
      frames
        .filter((frame) => frame.event.startsWith("response.web_search_call."))
        .map((frame) => frame.event),
    ).toEqual(
      Array(2)
        .fill([
          "response.web_search_call.in_progress",
          "response.web_search_call.searching",
          "response.web_search_call.completed",
        ])
        .flat(),
    );
  });

  it("未请求来源时仍为引用来源计算限额", () => {
    const encoder = new ResponsesStreamEncoder(undefined, {
      perItemBytes: 1000,
      perStreamBytes: 2000,
    });
    encoder.encode({ type: "response_start", id: "r", model: "m" });
    encoder.encode({ type: "web_search_start", id: search.id, query: search.query });
    expect(() =>
      encoder.encode({
        type: "web_search_result",
        execution: { ...search, results: [{ ...source, title: "x".repeat(1000) }] },
      }),
    ).toThrow(StreamOutputLimitError);
  });

  it("未完成的搜索不能生成完成响应", () => {
    const encoder = new ResponsesStreamEncoder();
    encoder.encode({ type: "response_start", id: "r", model: "m" });
    encoder.encode({ type: "web_search_start", id: search.id, query: search.query });
    expect(() => encoder.encode(completion)).toThrow();
    expect(encodeWebSearchCall("ws", "查询", "completed", []).action).toMatchObject({
      sources: [],
    });
  });
});
