from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:140]!r}")
    file.write_text(text.replace(old, new, 1))


# Shared stable tool-use ID derived from the response and execution identity.
internal = Path("src/providers/web-search/internal.ts")
text = internal.read_text()
helper = '''\nexport function createWebSearchToolUseId(\n  responseId: string,\n  executionId: string,\n  searchIndex: number,\n): string {\n  const digest = createHash("sha256")\n    .update(JSON.stringify([responseId, executionId, searchIndex]), "utf8")\n    .digest("base64url");\n  return `srvtoolu_ai_hub_${digest}`;\n}\n'''
if "createWebSearchToolUseId" not in text:
    text = text.rstrip() + "\n" + helper
internal.write_text(text)

# Non-streaming encoder: preserve execution id and derive IDs from response + execution.
replace_once(
    "src/protocols/anthropic/encode.ts",
    'import { createWebSearchReplayToken } from "../../providers/web-search/internal.js";\n',
    '''import {\n  createWebSearchReplayToken,\n  createWebSearchToolUseId,\n} from "../../providers/web-search/internal.js";\n''',
)
replace_once(
    "src/protocols/anthropic/encode.ts",
    '''  webSearchExecutions?: readonly {\n    query: string;\n    results: readonly { title: string; url: string }[];\n  }[];\n''',
    '''  webSearchExecutions?: readonly {\n    id: string;\n    query: string;\n    results: readonly { title: string; url: string }[];\n  }[];\n''',
)
replace_once(
    "src/protocols/anthropic/encode.ts",
    '''function encodeWebSearchBlocks(\n  executions: NonNullable<AnthropicEncodeOptions["webSearchExecutions"]>,\n): AnthropicResponseContentBlock[] {\n  return executions.flatMap((execution, index) => {\n    const toolUseId = `srvtoolu_ai_hub_${index}`;\n''',
    '''function encodeWebSearchBlocks(\n  responseId: string,\n  executions: NonNullable<AnthropicEncodeOptions["webSearchExecutions"]>,\n): AnthropicResponseContentBlock[] {\n  return executions.flatMap((execution, index) => {\n    const toolUseId = createWebSearchToolUseId(responseId, execution.id, index);\n''',
)
replace_once(
    "src/protocols/anthropic/encode.ts",
    '''      ...encodeWebSearchBlocks(options.webSearchExecutions ?? []),\n''',
    '''      ...encodeWebSearchBlocks(response.id, options.webSearchExecutions ?? []),\n''',
)

# Streaming encoder: use response_start id for the same deterministic ID derivation.
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    'import { createWebSearchReplayToken } from "../../providers/web-search/internal.js";\n',
    '''import {\n  createWebSearchReplayToken,\n  createWebSearchToolUseId,\n} from "../../providers/web-search/internal.js";\n''',
)
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    '''      ...this.#webSearchPrefixFrames(),\n''',
    '''      ...this.#webSearchPrefixFrames(event.id),\n''',
)
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    '''  #webSearchPrefixFrames(): AnthropicSseFrame[] {\n    const frames: AnthropicSseFrame[] = [];\n    for (const [searchIndex, execution] of (this.options.webSearchExecutions ?? []).entries()) {\n      const toolUseId = `srvtoolu_ai_hub_${searchIndex}`;\n''',
    '''  #webSearchPrefixFrames(responseId: string): AnthropicSseFrame[] {\n    const frames: AnthropicSseFrame[] = [];\n    for (const [searchIndex, execution] of (this.options.webSearchExecutions ?? []).entries()) {\n      const toolUseId = createWebSearchToolUseId(responseId, execution.id, searchIndex);\n''',
)

# Unit tests: import helper, provide required execution id, and derive expected stream id.
replace_once(
    "test/unit/web-search-usage.test.ts",
    '''  createWebSearchReplayToken,\n  INTERNAL_WEB_SEARCH_TOOL_NAME,\n''',
    '''  createWebSearchReplayToken,\n  createWebSearchToolUseId,\n  INTERNAL_WEB_SEARCH_TOOL_NAME,\n''',
)
replace_once(
    "test/unit/web-search-usage.test.ts",
    '''      { webSearchExecutions: [{ query, results: [result] }] },\n''',
    '''      { webSearchExecutions: [{ id: "call_search", query, results: [result] }] },\n''',
)
replace_once(
    "test/unit/web-search-usage.test.ts",
    '''    expect(frames).toContainEqual({\n      event: "content_block_start",\n      data: {\n        type: "content_block_start",\n        index: 0,\n        content_block: {\n          type: "server_tool_use",\n          id: "srvtoolu_ai_hub_0",\n          name: "web_search",\n          input: {},\n        },\n      },\n    });\n''',
    '''    const expectedToolUseId = createWebSearchToolUseId("msg_test", "call_search", 0);\n    expect(frames).toContainEqual({\n      event: "content_block_start",\n      data: {\n        type: "content_block_start",\n        index: 0,\n        content_block: {\n          type: "server_tool_use",\n          id: expectedToolUseId,\n          name: "web_search",\n          input: {},\n        },\n      },\n    });\n''',
)
replace_once(
    "test/unit/web-search-usage.test.ts",
    '''          tool_use_id: "srvtoolu_ai_hub_0",\n''',
    '''          tool_use_id: expectedToolUseId,\n''',
)

# Integration test: compute the same ID from the known final response/execution IDs.
app = Path("test/integration/app.test.ts")
app_text = app.read_text()
if "createWebSearchToolUseId" not in app_text:
    import_old = 'import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";\n'
    import_new = '''import {\n  createWebSearchToolUseId,\n  INTERNAL_WEB_SEARCH_TOOL_NAME,\n} from "../../src/providers/web-search/internal.js";\n'''
    if import_old not in app_text:
        raise SystemExit("app test internal web-search import not found")
    app_text = app_text.replace(import_old, import_new, 1)
old_block = '''    } else {\n      expect(response.json()).toMatchObject({\n        content: [\n          {\n            type: "server_tool_use",\n            id: "srvtoolu_ai_hub_0",\n            name: "web_search",\n            input: { query: "latest news" },\n          },\n          {\n            type: "web_search_tool_result",\n            tool_use_id: "srvtoolu_ai_hub_0",\n            content: [],\n          },\n'''
new_block = '''    } else {\n      const expectedToolUseId = createWebSearchToolUseId("resp_final", "call_search", 0);\n      expect(response.json()).toMatchObject({\n        content: [\n          {\n            type: "server_tool_use",\n            id: expectedToolUseId,\n            name: "web_search",\n            input: { query: "latest news" },\n          },\n          {\n            type: "web_search_tool_result",\n            tool_use_id: expectedToolUseId,\n            content: [],\n          },\n'''
if old_block not in app_text:
    raise SystemExit("integration web-search id block not found")
app.write_text(app_text.replace(old_block, new_block, 1))

# Add a direct uniqueness regression for repeated execution IDs across assistant responses.
test = Path("test/unit/web-search-replay-token.test.ts")
test_text = test.read_text()
test_text = test_text.replace(
    'import { createWebSearchReplayToken } from "../../src/providers/web-search/internal.js";\n',
    '''import {\n  createWebSearchReplayToken,\n  createWebSearchToolUseId,\n} from "../../src/providers/web-search/internal.js";\n''',
)
marker = '''});\n'''
case = '''\n  it("derives distinct server-tool IDs for the same execution id in different responses", () => {\n    const first = createWebSearchToolUseId("resp_turn_1", "call_search", 0);\n    const second = createWebSearchToolUseId("resp_turn_2", "call_search", 0);\n\n    expect(first).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);\n    expect(second).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);\n    expect(first).not.toBe(second);\n    expect(createWebSearchToolUseId("resp_turn_1", "call_search", 0)).toBe(first);\n  });\n'''
if "derives distinct server-tool IDs" not in test_text:
    pos = test_text.rfind(marker)
    if pos < 0:
        raise SystemExit("replay token test closing marker not found")
    test_text = test_text[:pos] + case + test_text[pos:]
test.write_text(test_text)
