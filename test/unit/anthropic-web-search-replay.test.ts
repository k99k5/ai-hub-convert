import { describe, expect, it } from "vitest";
import {
  AnthropicDecodeError,
  decodeAnthropicRequest,
} from "../../src/protocols/anthropic/decode.js";

describe("Anthropic Web Search history replay", () => {
  it("accepts assistant server web search history and keeps surrounding text", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "before" },
            {
              type: "server_tool_use",
              id: "srvtoolu_ai_hub_0",
              name: "web_search",
              input: { query: "2026 国庆" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_ai_hub_0",
              content: [
                {
                  type: "web_search_result",
                  title: "国务院办公厅通知",
                  url: "https://example.test/holiday",
                },
              ],
            },
            { type: "text", text: "after" },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });

    expect(decoded.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "text", text: "after" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("accepts official-style result metadata and search result errors", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_1",
              name: "web_search",
              input: { query: "current info" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Example",
                  url: "https://example.test",
                  encrypted_content: "opaque",
                  page_age: "September 7, 2026",
                },
              ],
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_2",
              content: {
                type: "web_search_tool_result_error",
                error_code: "max_uses_exceeded",
              },
            },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });

    expect(decoded.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("preserves an empty assistant turn when history contains only server search replay blocks", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "user", content: "search first" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srvtoolu_ai_hub_0",
              name: "web_search",
              input: { query: "current info" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_ai_hub_0",
              content: [],
            },
          ],
        },
        { role: "user", content: "continue" },
      ],
    });

    expect(decoded.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "search first" }] },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("still rejects malformed or non-assistant server search blocks", () => {
    for (const message of [
      {
        role: "user",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "x" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "not_web_search",
            input: { query: "x" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [{ type: "web_search_result", title: "missing url" }],
          },
        ],
      },
    ]) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 128,
          messages: [message],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });
});
