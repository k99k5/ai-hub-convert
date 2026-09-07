from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


internal = Path("src/providers/web-search/internal.ts")
text = internal.read_text()
if 'import { createHash } from "node:crypto";' not in text:
    text = 'import { createHash } from "node:crypto";\n\n' + text
helper = '''\nexport function createWebSearchReplayToken(\n  searchIndex: number,\n  resultIndex: number,\n  query: string,\n  result: { title: string; url: string },\n): string {\n  const digest = createHash("sha256")\n    .update(JSON.stringify([searchIndex, resultIndex, query, result.title, result.url]), "utf8")\n    .digest("base64url");\n  return `ai_hub_replay_v1:${digest}`;\n}\n'''
if "createWebSearchReplayToken" not in text:
    text = text.rstrip() + "\n" + helper
internal.write_text(text)

replace_once(
    "src/protocols/anthropic/types.ts",
    '''export interface AnthropicResponseWebSearchResult {\n  type: "web_search_result";\n  title: string;\n  url: string;\n}\n''',
    '''export interface AnthropicResponseWebSearchResult {\n  type: "web_search_result";\n  title: string;\n  url: string;\n  encrypted_content: string;\n}\n''',
)

replace_once(
    "src/protocols/anthropic/encode.ts",
    'import type { CanonicalResponse, Citation, FinishReason, ReasoningContent } from "../../core/ir.js";\n',
    'import type { CanonicalResponse, Citation, FinishReason, ReasoningContent } from "../../core/ir.js";\nimport { createWebSearchReplayToken } from "../../providers/web-search/internal.js";\n',
)
replace_once(
    "src/protocols/anthropic/encode.ts",
    '''        content: execution.results.map((result) => ({\n          type: "web_search_result" as const,\n          title: result.title,\n          url: result.url,\n        })),\n''',
    '''        content: execution.results.map((result, resultIndex) => ({\n          type: "web_search_result" as const,\n          title: result.title,\n          url: result.url,\n          encrypted_content: createWebSearchReplayToken(\n            index,\n            resultIndex,\n            execution.query,\n            result,\n          ),\n        })),\n''',
)

replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    'import type { Content, Usage } from "../../core/ir.js";\n',
    'import type { Content, Usage } from "../../core/ir.js";\nimport { createWebSearchReplayToken } from "../../providers/web-search/internal.js";\n',
)
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    '''      const resultContent = execution.results.map((result) => ({\n        type: "web_search_result",\n        title: result.title,\n        url: result.url,\n      }));\n''',
    '''      const resultContent = execution.results.map((result, resultIndex) => ({\n        type: "web_search_result",\n        title: result.title,\n        url: result.url,\n        encrypted_content: createWebSearchReplayToken(\n          searchIndex,\n          resultIndex,\n          execution.query,\n          result,\n        ),\n      }));\n''',
)

replace_once(
    "test/unit/web-search-usage.test.ts",
    'import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";\n',
    '''import {\n  createWebSearchReplayToken,\n  INTERNAL_WEB_SEARCH_TOOL_NAME,\n} from "../../src/providers/web-search/internal.js";\n''',
)

marker = '''  it("emits server_tool_use.web_search_requests in streaming Anthropic usage", () => {\n'''
nonstream_test = '''  it("emits replayable encrypted_content in non-streaming Anthropic Web Search results", () => {\n    const query = "2026年10月1日 国庆节 星期几";\n    const result = {\n      title: "2026年国庆节",\n      url: "https://example.com/national-day",\n    };\n    const expectedReplayToken = createWebSearchReplayToken(0, 0, query, result);\n    const response = encodeAnthropicResponse(\n      {\n        id: "msg_test",\n        model: "test-model",\n        content: [{ type: "text", text: "done" }],\n        finishReason: "end_turn",\n        usage: { inputTokens: 10, outputTokens: 2, webSearchRequests: 1 },\n      },\n      { webSearchExecutions: [{ query, results: [result] }] },\n    );\n\n    expect(response.content[1]).toMatchObject({\n      type: "web_search_tool_result",\n      content: [\n        {\n          type: "web_search_result",\n          title: result.title,\n          url: result.url,\n          encrypted_content: expectedReplayToken,\n        },\n      ],\n    });\n  });\n\n'''
file = Path("test/unit/web-search-usage.test.ts")
text = file.read_text()
if "emits replayable encrypted_content in non-streaming Anthropic Web Search results" not in text:
    if marker not in text:
        raise SystemExit("non-stream test marker not found")
    text = text.replace(marker, nonstream_test + marker, 1)
file.write_text(text)

replace_once(
    "test/unit/web-search-usage.test.ts",
    '''              type: "web_search_result",\n              title: "2026年国庆节",\n              url: "https://example.com/national-day",\n''',
    '''              type: "web_search_result",\n              title: "2026年国庆节",\n              url: "https://example.com/national-day",\n              encrypted_content: createWebSearchReplayToken(\n                0,\n                0,\n                "2026年10月1日 国庆节 星期几",\n                { title: "2026年国庆节", url: "https://example.com/national-day" },\n              ),\n''',
)

# Make the replay fixture reflect the strict Anthropic result shape as well.
replay = Path("test/unit/anthropic-web-search-replay.test.ts")
replay_text = replay.read_text()
old = '''                  type: "web_search_result",\n                  title: "国务院办公厅通知",\n                  url: "https://example.test/holiday",\n'''
new = '''                  type: "web_search_result",\n                  title: "国务院办公厅通知",\n                  url: "https://example.test/holiday",\n                  encrypted_content: "ai_hub_replay_v1:test",\n'''
if old in replay_text:
    replay.write_text(replay_text.replace(old, new, 1))
