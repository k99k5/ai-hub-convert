from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise RuntimeError(f"marker not found in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/protocols/anthropic/decode.ts",
    '''  for (const block of record.content) {
    if (isRecord(block) && block.type === "tool_result") {
      if (role !== "user") {
        return invalidRequest();
      }
      flushCurrent();
      messages.push(parseToolResult(block));
    } else {
      current.push(parseRegularBlock(block, role));
    }
  }
''',
    '''  for (const block of record.content) {
    if (
      isRecord(block) &&
      (block.type === "server_tool_use" || block.type === "web_search_tool_result")
    ) {
      if (role !== "assistant") {
        return invalidRequest();
      }
      if (block.type === "server_tool_use") {
        const input = block.input;
        if (
          block.name !== "web_search" ||
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          !isRecord(input) ||
          typeof input.query !== "string"
        ) {
          return invalidRequest();
        }
      } else {
        if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
          return invalidRequest();
        }
        const content = block.content;
        if (
          !Array.isArray(content) &&
          !(
            isRecord(content) &&
            content.type === "web_search_tool_result_error" &&
            typeof content.error_code === "string"
          )
        ) {
          return invalidRequest();
        }
        if (
          Array.isArray(content) &&
          !content.every(
            (item) =>
              isRecord(item) &&
              item.type === "web_search_result" &&
              typeof item.url === "string" &&
              typeof item.title === "string",
          )
        ) {
          return invalidRequest();
        }
      }
      continue;
    }
    if (isRecord(block) && block.type === "tool_result") {
      if (role !== "user") {
        return invalidRequest();
      }
      flushCurrent();
      messages.push(parseToolResult(block));
    } else {
      current.push(parseRegularBlock(block, role));
    }
  }
''',
)

Path("test/unit/anthropic-web-search-replay.test.ts").write_text(
    '''import { describe, expect, it } from "vitest";
import { AnthropicDecodeError, decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";

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
'''
)
