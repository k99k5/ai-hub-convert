import { describe, expect, it } from "vitest";
import type { CanonicalRequest } from "../../src/core/ir.js";
import {
  decodeAnthropicRequest,
  decodeAnthropicRequestWithSidecar,
  decodeAnthropicTokenCountRequest,
} from "../../src/protocols/anthropic/decode.js";
import { decodeChatRequest } from "../../src/protocols/openai-chat/request-decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import { normalizeResponsesInput } from "../../src/protocols/openai-responses/input-normalize.js";

const diagnostic = "client-private-diagnostic";
const business = { client_extra: "user-business-value", nested: { custom: true } };
const metadata = { client_extra: "user-business-value" };
const schema = {
  type: "object",
  properties: { client_extra: { type: "string" } },
  required: ["client_extra"],
  additionalProperties: true,
  "x-custom": business,
};
const argumentsJson = JSON.stringify(business);

// Add client fields to every protocol envelope, leaving application-owned JSON intact.
function withExtras(value: unknown): unknown {
  if (value === schema || value === business || value === metadata) return structuredClone(value);
  if (Array.isArray(value)) return value.map(withExtras);
  if (value === null || typeof value !== "object") return value;
  return {
    ...Object.fromEntries(Object.entries(value).map(([key, child]) => [key, withExtras(child)])),
    client_extra: diagnostic,
  };
}

const chat = {
  model: "m",
  messages: [
    { role: "system", content: "instructions" },
    {
      role: "user",
      content: [
        { type: "text", text: argumentsJson },
        { type: "image_url", image_url: { url: "https://example.test/image.png", detail: "high" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: argumentsJson } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: argumentsJson }] },
  ],
  tools: [{ type: "function", function: { name: "lookup", parameters: schema } }],
  tool_choice: { type: "function", function: { name: "lookup" } },
  response_format: { type: "json_schema", json_schema: { name: "answer", schema } },
  thinking: { type: "enabled" },
  reasoning: { effort: "high" },
  stream: true,
  stream_options: { include_usage: true },
  metadata,
};
const responses = {
  model: "m",
  input: [
    {
      type: "message",
      id: "msg_user",
      role: "user",
      content: [
        { type: "input_text", text: argumentsJson },
        { type: "input_image", image_url: "https://example.test/image.png", detail: "high" },
      ],
    },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "thinking" }],
      encrypted_content: "opaque",
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "lookup",
      arguments: argumentsJson,
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: [{ type: "input_text", text: argumentsJson }],
    },
    {
      role: "assistant",
      content: [
        { type: "output_text", text: "answer" },
        { type: "refusal", refusal: "refusal" },
      ],
    },
    {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: {
        type: "search",
        queries: ["query"],
        sources: [{ type: "url", url: "https://example.test" }],
      },
    },
  ],
  tools: [
    { type: "function", name: "lookup", parameters: schema },
    {
      type: "web_search",
      filters: { allowed_domains: ["example.test"] },
      user_location: { type: "approximate", city: "Shanghai" },
    },
  ],
  tool_choice: {
    type: "allowed_tools",
    mode: "auto",
    tools: [{ type: "function", name: "lookup" }],
  },
  text: { verbosity: "low", format: { type: "json_schema", name: "answer", schema } },
  reasoning: { effort: "high", summary: "auto" },
  metadata,
};
const anthropic = {
  model: "m",
  max_tokens: 256,
  system: [{ type: "text", text: "instructions", cache_control: { type: "ephemeral" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: argumentsJson }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "lookup", input: business }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: argumentsJson }],
        },
      ],
    },
  ],
  tools: [
    { name: "lookup", input_schema: schema, cache_control: { type: "ephemeral", ttl: "1h" } },
  ],
  tool_choice: { type: "tool", name: "lookup" },
  output_config: { effort: "high", format: { type: "json_schema", schema } },
  thinking: { type: "enabled", budget_tokens: 128, display: "summarized" },
  metadata,
};

describe("忽略未知请求字段", () => {
  it.each<{ name: string; input: unknown; decode: (input: unknown) => CanonicalRequest }>([
    { name: "Chat", input: chat, decode: decodeChatRequest },
    { name: "Responses", input: responses, decode: decodeResponsesRequest },
    { name: "Anthropic", input: anthropic, decode: decodeAnthropicRequest },
    {
      name: "Anthropic token counting",
      input: anthropic,
      decode: decodeAnthropicTokenCountRequest,
    },
  ])("$name 忽略嵌套附加字段，完整保留 schema、工具参数和 metadata", ({ input, decode }) => {
    const noisy = withExtras(input);
    const snapshot = structuredClone(noisy);
    const expected = decode(input);
    const actual = decode(noisy);
    expect(actual).toEqual(expected);
    expect(noisy).toEqual(snapshot);
    expect(JSON.stringify(actual)).not.toContain(diagnostic);
    expect(actual.tools[0]).toMatchObject({ inputSchema: schema });
    const call = actual.messages
      .flatMap((message) => message.content)
      .find((part) => part.type === "function_call");
    expect(call).toMatchObject({ arguments: argumentsJson });
    expect(encodeChatRequest(actual)).toEqual(encodeChatRequest(expected));
    expect(actual.metadata ?? actual.extensions?.request?.metadata).toEqual(metadata);
    const options = {
      store: false as const,
      replaySourceExtensions: true,
      promptCache: { kind: "none" as const },
    };
    expect(encodeResponsesRequest(actual, options)).toEqual(
      encodeResponsesRequest(expected, options),
    );
  });

  it("忽略 cache_control 附加字段，不改变 Anthropic 缓存断点", () => {
    expect(decodeAnthropicRequestWithSidecar(withExtras(anthropic))).toEqual(
      decodeAnthropicRequestWithSidecar(anthropic),
    );
  });

  it.each([
    { type: "disabled" },
    { type: "adaptive", display: "omitted" },
  ])("不把 thinking 的未知字段保留在来源扩展中：%j", (thinking) => {
    const clean = { ...anthropic, thinking };
    expect(decodeAnthropicRequest(withExtras(clean))).toEqual(decodeAnthropicRequest(clean));
  });

  it("续轮历史只保留协议字段，文本和序列化工具参数中的同名键不受影响", () => {
    const input = [...responses.input, { type: "item_reference", id: "msg_ref" }];
    const noisy = withExtras(input) as unknown[];
    decodeResponsesRequest({ model: "m", input: noisy });
    const normalized = normalizeResponsesInput(noisy);
    expect(normalized).toEqual(input);
    expect(JSON.stringify(normalized)).not.toContain(diagnostic);
    expect(normalized[2]).toHaveProperty("arguments", argumentsJson);
  });

  it.each([
    { type: "open_page", url: "https://example.test" },
    { type: "find_in_page", url: "https://example.test", pattern: "answer" },
  ])("历史归一化忽略不属于当前搜索动作的字段：$type", (action) => {
    const clean = { type: "web_search_call", id: "ws_1", status: "completed", action };
    const noisy = {
      ...clean,
      action: { ...action, sources: [null], queries: { client_extra: diagnostic } },
    };
    expect(decodeResponsesRequest({ model: "m", input: [noisy] })).toEqual(
      decodeResponsesRequest({ model: "m", input: [clean] }),
    );
    expect(normalizeResponsesInput([noisy])).toEqual([clean]);
  });

  it.each([
    { decode: decodeChatRequest, input: { ...chat, stream: "true" } },
    {
      decode: decodeChatRequest,
      input: { ...chat, messages: [{ role: "user", content: [{ type: "unknown" }] }] },
    },
    { decode: decodeResponsesRequest, input: { ...responses, tools: [{ type: "unknown" }] } },
    { decode: decodeResponsesRequest, input: { ...responses, max_output_tokens: "256" } },
    { decode: decodeAnthropicRequest, input: { ...anthropic, thinking: { type: "unknown" } } },
    { decode: decodeAnthropicRequest, input: { ...anthropic, output_config: { effort: 1 } } },
  ])("未知字段不掩盖已知字段或类型错误 %#", ({ decode, input }) => {
    expect(() => decode(withExtras(input))).toThrow();
  });
});
