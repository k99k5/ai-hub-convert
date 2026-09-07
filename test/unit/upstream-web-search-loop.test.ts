import { describe, expect, it } from "vitest";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";
import { UpstreamClient } from "../../src/upstream/client.js";

// The default provider intentionally returns zero results until a real search provider is wired in.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "upstream_req" },
  });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("Upstream Web Search tool loop", () => {
  it("executes a Responses Web Search call as an empty provider result", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      {
        id: "resp_search",
        model: "deepseek-test",
        status: "completed",
        output: [
          {
            id: "fc_search",
            type: "function_call",
            status: "completed",
            call_id: "call_search",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            arguments: '{"query":"latest news"}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      {
        id: "resp_final",
        model: "deepseek-test",
        status: "completed",
        output: [
          {
            id: "msg_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "No search results.", annotations: [] }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    ];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(requestBody(init));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected upstream request");
      }
      return jsonResponse(response);
    };
    const client = new UpstreamClient({
      baseUrl: new URL("https://upstream.test/v1/"),
      timeoutMs: 1_000,
      fetch,
    });

    const result = await client.postJson(
      "responses",
      {
        model: "deepseek-test",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "search" }] },
        ],
        tools: [
          {
            type: "function",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            parameters: { type: "object" },
            strict: true,
          },
        ],
        stream: false,
        store: false,
      },
      "test-key",
      new AbortController().signal,
    );

    expect(result).toMatchObject({ id: "resp_final" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.stream).toBe(false);
    expect(JSON.stringify(bodies[1]?.tools)).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
    expect(bodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_search",
          output: JSON.stringify({
            ok: true,
            result_count: 0,
            results: [],
            message: "Web search completed successfully with 0 results. This is not an API error.",
          }),
        }),
      ]),
    );
  });

  it("buffers a Web Search round and synthesizes a valid Responses event stream", async () => {
    const responses = [
      {
        id: "resp_search",
        model: "deepseek-test",
        status: "completed",
        output: [
          {
            id: "fc_search",
            type: "function_call",
            status: "completed",
            call_id: "call_search",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            arguments: '{"query":"weather"}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
      {
        id: "resp_final",
        model: "deepseek-test",
        status: "completed",
        output: [
          {
            id: "msg_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "No results found.", annotations: [] }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    ];
    const fetch = async (_input: string | URL | Request): Promise<Response> => {
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected upstream request");
      }
      return jsonResponse(response);
    };
    const client = new UpstreamClient({
      baseUrl: new URL("https://upstream.test/v1/"),
      timeoutMs: 1_000,
      fetch,
    });

    const response = await client.postStream(
      "responses",
      {
        model: "deepseek-test",
        input: [],
        tools: [
          {
            type: "function",
            name: INTERNAL_WEB_SEARCH_TOOL_NAME,
            parameters: { type: "object" },
            strict: true,
          },
        ],
        stream: true,
        store: false,
      },
      "test-key",
      new AbortController().signal,
    );
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("response.created");
    expect(text).toContain("No results found.");
    expect(text).toContain("[DONE]");
    expect(text).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
  });

  it("executes the same empty-result loop for Chat Completions fallback", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [
      {
        id: "chat_search",
        model: "deepseek-test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_search",
                  type: "function",
                  function: {
                    name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                    arguments: '{"query":"docs"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      {
        id: "chat_final",
        model: "deepseek-test",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "No search results." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      },
    ];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(requestBody(init));
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected upstream request");
      }
      return jsonResponse(response);
    };
    const client = new UpstreamClient({
      baseUrl: new URL("https://upstream.test/v1/"),
      timeoutMs: 1_000,
      fetch,
    });

    const result = await client.postJson(
      "chat/completions",
      {
        model: "deepseek-test",
        messages: [{ role: "user", content: "search" }],
        tools: [
          {
            type: "function",
            function: {
              name: INTERNAL_WEB_SEARCH_TOOL_NAME,
              parameters: { type: "object" },
              strict: true,
            },
          },
        ],
        stream: false,
      },
      "test-key",
      new AbortController().signal,
    );

    expect(result).toMatchObject({ id: "chat_final" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_search",
          content: JSON.stringify({
            ok: true,
            result_count: 0,
            results: [],
            message: "Web search completed successfully with 0 results. This is not an API error.",
          }),
        }),
      ]),
    );
  });
});
