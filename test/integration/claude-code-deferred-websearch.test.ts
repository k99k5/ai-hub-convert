import { responsesStream } from "../helpers/upstream.js";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

it("owns Claude Code deferred WebSearch and completes an empty search without leaking tool_use", async () => {
  const bodies: Record<string, unknown>[] = [];
  let round = 0;
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://gateway.example.test/v1" }),
    logger: false,
    upstreamFetch: async (input, init) => {
      const request = new Request(input, init);
      bodies.push((await request.json()) as Record<string, unknown>);
      round += 1;
      if (round === 1) {
        return responsesStream({
          id: "resp_search",
          model: "deepseek-v4-flash",
          status: "completed",
          output: [
            {
              id: "fc_search",
              type: "function_call",
              status: "completed",
              call_id: "call_search",
              name: INTERNAL_WEB_SEARCH_TOOL_NAME,
              arguments: '{"query":"2026年10月1日 国庆节 星期几"}',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1 },
        });
      }
      return responsesStream({
        id: "resp_final",
        model: "deepseek-v4-flash",
        status: "completed",
        output: [
          {
            id: "msg_final",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "搜索没有返回结果。" }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      });
    },
  });
  apps.push(app);

  const response = await app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: {
      "content-type": "application/json",
      "x-api-key": "caller-key",
      "user-agent": "claude-cli/2.1.220 (external, cli)",
    },
    payload: {
      model: "deepseek-v4-flash",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "2026年10月1日 国庆节 星期几" }],
      tools: [
        {
          type: "tool_search_tool_regex_20251119",
          name: "tool_search_tool_regex",
        },
        {
          name: "WebSearch",
          description: "Search the web",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          defer_loading: true,
        },
      ],
    },
  });

  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["content-type"]).toContain("text/event-stream");
  expect(response.body).toContain("搜索没有返回结果。");
  expect(response.body).not.toContain("WebSearch");
  expect(response.body).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
  expect(bodies).toHaveLength(2);
  expect(JSON.stringify(bodies[0]?.tools)).toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);
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
