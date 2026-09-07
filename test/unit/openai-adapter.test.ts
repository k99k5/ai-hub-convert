import { describe, expect, it } from "vitest";
import type { CanonicalRequest, CanonicalResponse } from "../../src/core/ir.js";
import type { PromptCacheCapability } from "../../src/policies/cache/capabilities.js";
import { decodeChatResponse } from "../../src/protocols/openai-chat/decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import {
  decodeResponsesInputTokensResponse,
  encodeResponsesInputTokensRequest,
} from "../../src/protocols/openai-responses/input-tokens.js";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesResponse } from "../../src/protocols/openai-responses/response-encode.js";
import { decodeResponsesResponse } from "../../src/protocols/openai-responses/decode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";
import {
  INTERNAL_WEB_SEARCH_TOOL_NAME,
  INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
} from "../../src/providers/web-search/internal.js";

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    source: "anthropic",
    model: "gpt-test",
    messages: [],
    tools: [],
    stream: false,
    ...overrides,
  };
}

const noPromptCache = { kind: "none" } as const;
const promptCacheKeyCapability: PromptCacheCapability = { kind: "prompt-cache-key" };

describe("OpenAI Responses adapter", () => {
  it.each([
    "medium",
    null,
  ] as const)("encodes canonical effort %s for Responses and input token counting", (reasoningEffort) => {
    const request = baseRequest({ reasoningEffort });

    expect(
      encodeResponsesRequest(request, { store: false, promptCache: noPromptCache }),
    ).toHaveProperty("reasoning", { effort: reasoningEffort });
    expect(encodeResponsesInputTokensRequest(request)).toHaveProperty("reasoning", {
      effort: reasoningEffort,
    });
  });

  it("omits reasoning from Responses and input token counting when effort is absent", () => {
    const request = baseRequest();

    expect(
      encodeResponsesRequest(request, { store: false, promptCache: noPromptCache }),
    ).not.toHaveProperty("reasoning");
    expect(encodeResponsesInputTokensRequest(request)).not.toHaveProperty("reasoning");
  });

  it("preserves the complete same-protocol reasoning object", () => {
    const request = decodeResponsesRequest({
      model: "gpt-test",
      input: "hello",
      reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
    });

    expect(
      encodeResponsesRequest(request, {
        store: false,
        replaySourceExtensions: true,
        promptCache: noPromptCache,
      }),
    ).toHaveProperty("reasoning", {
      effort: "medium",
      summary: "auto",
      context: "all_turns",
    });
  });

  it("decodes string input and preserves supported request controls", () => {
    expect(
      decodeResponsesRequest({
        model: "gpt-test",
        input: "hello",
        max_output_tokens: 100,
        stream: false,
        store: true,
        previous_response_id: "resp_previous",
        parallel_tool_calls: true,
        temperature: 0.2,
        top_p: 0.9,
        metadata: { tenant: "test" },
      }),
    ).toEqual({
      source: "openai-responses",
      model: "gpt-test",
      maxOutputTokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      parallelToolCalls: true,
      stream: false,
      temperature: 0.2,
      topP: 0.9,
      metadata: { tenant: "test" },
      extensions: {
        source: "openai-responses",
        request: { store: true, previous_response_id: "resp_previous" },
      },
    });
  });

  it("decodes supported messages, images, reasoning, function calls, results, and tools", () => {
    expect(
      decodeResponsesRequest({
        model: "gpt-test",
        instructions: "be concise",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "inspect" },
              { type: "input_image", detail: "auto", image_url: "https://example.test/a.png" },
              {
                type: "input_image",
                detail: "low",
                image_url: "data:image/png;base64,aGVsbG8=",
              },
            ],
          },
          {
            id: "rs_input",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "thought" }],
            encrypted_content: "opaque-state",
          },
          { type: "function_call", call_id: "call_1", name: "weather", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: "sunny" },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        ],
        tool_choice: { type: "function", name: "weather" },
      }),
    ).toMatchObject({
      source: "openai-responses",
      model: "gpt-test",
      messages: [
        { role: "developer", content: [{ type: "text", text: "be concise" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              id: "rs_input",
              text: "thought",
              source: "openai-responses",
              opaque: {
                provider: "openai-responses",
                kind: "reasoning",
                value: "opaque-state",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "function_call", id: "call_1", name: "weather", arguments: "{}" }],
        },
        {
          role: "tool",
          content: [{ type: "function_result", callId: "call_1", output: "sunny", isError: false }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          inputSchema: { type: "object", properties: {} },
          strict: true,
        },
      ],
      toolChoice: { type: "function", name: "weather" },
      stream: false,
    });
  });

  it("distinguishes built-in Web Search from a function with the same name", () => {
    const stable = decodeResponsesRequest({
      model: "gpt-test",
      input: "search",
      tools: [
        { type: "web_search" },
        {
          type: "function",
          name: "web_search",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const versioned = decodeResponsesRequest({
      model: "gpt-test",
      input: "search",
      tools: [
        { type: "web_search_2025_08_26" },
        { type: "web_search_preview", search_content_types: ["text", "image"] },
        { type: "web_search_preview_2025_03_11" },
      ],
    });

    expect(stable.tools).toEqual([
      { type: "web_search", provider: "web-search", version: "web_search" },
      {
        type: "function",
        name: "web_search",
        inputSchema: { type: "object", properties: {} },
        strict: false,
      },
    ]);
    expect(versioned.tools).toEqual([
      {
        type: "web_search",
        provider: "web-search",
        version: "web_search_2025_08_26",
      },
      {
        type: "web_search",
        provider: "web-search",
        version: "web_search_preview",
      },
      {
        type: "web_search",
        provider: "web-search",
        version: "web_search_preview_2025_03_11",
      },
    ]);
  });

  it("rejects unknown and malformed built-in Web Search declarations", () => {
    const malformedTools = [
      { type: "web_search_2026_01_01" },
      { type: "web_search", search_context_size: "maximum" },
      { type: "web_search", search_content_types: ["text"] },
      { type: "web_search_preview", filters: { allowed_domains: ["example.test"] } },
      { type: "web_search_preview", search_content_types: ["video"] },
      { type: "web_search", filters: { allowed_domains: "example.test" } },
      { type: "web_search", user_location: { type: "exact", city: "Paris" } },
    ];

    for (const tool of malformedTools) {
      expect(() =>
        decodeResponsesRequest({
          model: "gpt-test",
          input: "search",
          tools: [tool],
        }),
      ).toThrow();
    }
  });

  it("applies version-specific Web Search location requirements", () => {
    expect(() =>
      decodeResponsesRequest({
        model: "gpt-test",
        input: "search",
        tools: [{ type: "web_search", user_location: { city: "Paris" } }],
      }),
    ).not.toThrow();
    expect(() =>
      decodeResponsesRequest({
        model: "gpt-test",
        input: "search",
        tools: [{ type: "web_search_preview", user_location: { city: "Paris" } }],
      }),
    ).toThrow(/invalid Web Search user location/);
  });

  it("rejects unsupported top-level controls instead of silently changing semantics", () => {
    expect(() =>
      decodeResponsesRequest({
        model: "gpt-test",
        input: "hello",
        conversation: "conv_1",
      }),
    ).toThrow(/Unsupported OpenAI Responses request field/);
  });

  it("rejects non-JSON reasoning controls and sanitizes incomplete details", () => {
    expect(() =>
      decodeResponsesRequest({
        model: "gpt-test",
        input: "hello",
        reasoning: { effort: Number.NaN },
      }),
    ).toThrow(/reasoning must contain JSON values/);

    const encoded = encodeResponsesResponse(
      decodeResponsesResponse(
        {
          id: "resp_incomplete",
          object: "response",
          model: "gpt-test",
          status: "incomplete",
          incomplete_details: {
            reason: "max_output_tokens",
            private_secret: "must-not-replay",
          },
          output: [],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
        { preserveWireMetadata: true },
      ),
    );
    expect(encoded).toMatchObject({
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(JSON.stringify(encoded)).not.toContain("must-not-replay");
  });

  it("rejects background mode and unsupported input types", () => {
    expect(() =>
      decodeResponsesRequest({ model: "gpt-test", input: "hello", background: true }),
    ).toThrow(/Background Responses are not supported/);
    expect(() =>
      decodeResponsesRequest({
        model: "gpt-test",
        input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "f" }] }],
      }),
    ).toThrow(/Unsupported OpenAI Responses input/);
  });

  it("normalizes and re-encodes a non-stream Responses body", () => {
    const upstream = {
      id: "resp_1",
      object: "response",
      created_at: 1_722_000_000,
      model: "gpt-test",
      status: "completed",
      incomplete_details: null,
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: "thought" }],
          encrypted_content: "opaque-state",
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "answer", annotations: [] }],
        },
        {
          id: "fc_1",
          type: "function_call",
          status: "completed",
          call_id: "call_1",
          name: "weather",
          arguments: "{}",
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 8,
        total_tokens: 28,
        input_tokens_details: { cached_tokens: 6 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
    };

    expect(
      encodeResponsesResponse(decodeResponsesResponse(upstream, { preserveWireMetadata: true })),
    ).toEqual(upstream);
  });

  it("validates Responses response metadata and output layout without leaking values", () => {
    const base: CanonicalResponse = {
      id: "resp_metadata",
      model: "gpt-test",
      content: [{ type: "text", text: "hello" }],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      extensions: {
        source: "openai-responses",
        response: {
          status: "completed",
          usage: {},
          output_layout: [{ type: "message", contentCount: 1 }],
        },
      },
    };
    const withoutExtensions: CanonicalResponse = {
      id: base.id,
      model: base.model,
      content: base.content,
      finishReason: base.finishReason,
      usage: base.usage,
    };
    const invalidResponses: CanonicalResponse[] = [
      withoutExtensions,
      { ...base, extensions: { source: "openai-chat" } },
      { ...base, extensions: { source: "openai-responses" } },
      {
        ...base,
        extensions: { source: "openai-responses", response: { status: "failed" } },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: { status: "completed", usage: null, output_layout: [] },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: { input_tokens_details_present: "private-secret" },
            output_layout: [],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: { output_tokens_details_present: 1 },
            output_layout: [],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: { status: "completed", usage: {}, output_layout: null },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: {},
            output_layout: [{ type: "audio", contentCount: 1 }],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: {},
            output_layout: [{ type: "message", contentCount: -1 }],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: {},
            output_layout: [{ type: "message", contentCount: 1, status: "private-secret" }],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: {},
            output_layout: [{ type: "message", contentCount: 1, role: "user" }],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            usage: {},
            output_layout: [{ type: "message", contentCount: 2 }],
          },
        },
      },
      {
        ...base,
        extensions: {
          source: "openai-responses",
          response: { status: "completed", usage: {}, output_layout: [] },
        },
      },
    ];

    for (const response of invalidResponses) {
      let thrown: unknown;
      try {
        encodeResponsesResponse(response);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: "OpenAIAdapterError",
        code: "INVALID_OPENAI_RESPONSES_RESPONSE",
      });
      expect(String(thrown)).not.toContain("private-secret");
    }
  });

  it("encodes a validated mixed Responses output layout", () => {
    const response: CanonicalResponse = {
      id: "resp_mixed",
      model: "gpt-test",
      content: [
        {
          type: "text",
          text: "answer",
          citations: [{ type: "url", url: "https://example.test/source" }],
        },
        { type: "refusal", refusal: "cannot" },
        {
          type: "reasoning",
          text: "plan",
          source: "openai-responses",
          opaque: {
            provider: "openai-responses",
            kind: "reasoning",
            value: "encrypted",
          },
        },
        { type: "function_call", id: "call_1", name: "tool", arguments: "{}" },
      ],
      finishReason: "tool_use",
      usage: {
        inputTokens: 4,
        outputTokens: 3,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 2,
        reasoningTokens: 1,
      },
      extensions: {
        source: "openai-responses",
        response: {
          object: "response",
          created_at: 1,
          status: "completed",
          usage: {
            total_tokens: 7,
            input_tokens_details_present: true,
            output_tokens_details_present: true,
          },
          output_layout: [
            { type: "message", contentCount: 2, id: "msg_1", status: "completed" },
            { type: "reasoning", contentCount: 1, id: "rs_1" },
            { type: "function_call", contentCount: 1, id: "fc_1" },
          ],
        },
      },
    };

    expect(encodeResponsesResponse(response)).toMatchObject({
      object: "response",
      created_at: 1,
      output: [
        {
          id: "msg_1",
          type: "message",
          content: [
            {
              type: "output_text",
              annotations: [{ type: "url_citation", url: "https://example.test/source" }],
            },
            { type: "refusal", refusal: "cannot" },
          ],
        },
        { id: "rs_1", type: "reasoning", encrypted_content: "encrypted" },
        { id: "fc_1", type: "function_call", call_id: "call_1", name: "tool" },
      ],
      usage: {
        total_tokens: 7,
        input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    });
  });

  it("does not replay unknown upstream usage detail fields", () => {
    const response = decodeResponsesResponse(
      {
        id: "resp_usage",
        object: "response",
        model: "gpt-test",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          input_tokens_details: { cached_tokens: 3, private_secret: "must-not-replay" },
          output_tokens_details: { reasoning_tokens: 2, private_secret: "must-not-replay" },
        },
      },
      { preserveWireMetadata: true },
    );

    const encoded = encodeResponsesResponse(response);
    expect(encoded).toMatchObject({
      usage: {
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });
    expect(JSON.stringify(encoded)).not.toContain("must-not-replay");
  });

  it("encodes only input token count fields and validates the upstream count", () => {
    expect(
      encodeResponsesInputTokensRequest(
        baseRequest({
          maxOutputTokens: 123,
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          temperature: 0.3,
          metadata: { ignored: true },
        }),
      ),
    ).toEqual({
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
    expect(
      decodeResponsesInputTokensResponse({
        object: "response.input_tokens",
        input_tokens: 42,
      }),
    ).toBe(42);
    expect(() =>
      decodeResponsesInputTokensResponse({
        object: "response.input_tokens",
        input_tokens: -1,
      }),
    ).toThrow(/Invalid Responses input token count response/);
    expect(() => decodeResponsesInputTokensResponse({ object: "other", input_tokens: 42 })).toThrow(
      /Invalid Responses input token count response/,
    );
  });

  it("encodes ordered multimodal history, parallel function calls, and request controls", () => {
    const request = baseRequest({
      maxOutputTokens: 512,
      messages: [
        { role: "system", content: [{ type: "text", text: "system" }] },
        { role: "developer", content: [{ type: "text", text: "developer" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "function_call", id: "call_weather", name: "weather", arguments: "{}" },
            { type: "function_call", id: "call_time", name: "time", arguments: "{}" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "function_result",
              callId: "call_weather",
              output: "sunny",
              isError: false,
            },
            {
              type: "function_result",
              callId: "call_time",
              output: "12:00",
              isError: false,
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          inputSchema: { type: "object", properties: {} },
          strict: true,
        },
      ],
      toolChoice: { type: "function", name: "weather" },
      parallelToolCalls: true,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["do-not-forward"],
      metadata: { tenant: "test" },
    });

    expect(
      encodeResponsesRequest(request, {
        store: false,
        promptCache: promptCacheKeyCapability,
        promptCacheKey: "cache-key",
      }),
    ).toEqual({
      model: "gpt-test",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "developer" }],
        },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            {
              type: "input_image",
              detail: "auto",
              image_url: "https://example.test/image.png",
            },
            {
              type: "input_image",
              detail: "auto",
              image_url: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "input_text", text: "calling tools" }],
        },
        {
          type: "function_call",
          call_id: "call_weather",
          name: "weather",
          arguments: "{}",
        },
        { type: "function_call", call_id: "call_time", name: "time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_weather", output: "sunny" },
        { type: "function_call_output", call_id: "call_time", output: "12:00" },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: true,
      max_output_tokens: 512,
      stream: false,
      temperature: 0.2,
      top_p: 0.9,
      metadata: { tenant: "test" },
      store: false,
      prompt_cache_key: "cache-key",
    });
  });

  it("suppresses prompt cache keys when the provider capability is none", () => {
    const request = decodeResponsesRequest({
      model: "gpt-test",
      input: "hello",
      prompt_cache_key: "caller-cache-key",
    });

    expect(
      encodeResponsesRequest(request, {
        store: false,
        replaySourceExtensions: true,
        promptCache: noPromptCache,
        promptCacheKey: "generated-cache-key",
      }),
    ).not.toHaveProperty("prompt_cache_key");
    expect(
      encodeResponsesInputTokensRequest({
        ...request,
        extensions: {
          source: "openai-responses",
          request: { prompt_cache_key: "count-cache-key" },
        },
      }),
    ).not.toHaveProperty("prompt_cache_key");
  });

  it("materializes built-in Web Search as the reserved upstream Responses function", () => {
    const request = baseRequest({
      tools: [{ type: "web_search", provider: "web-search", version: "web_search" }],
      toolChoice: { type: "function", name: "web_search" },
    });

    const encoded = encodeResponsesRequest(request, {
      store: false,
      promptCache: noPromptCache,
    });
    expect(encoded.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: INTERNAL_WEB_SEARCH_TOOL_NAME,
        parameters: INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
        strict: true,
      }),
    ]);
    expect(encoded.tool_choice).toEqual({
      type: "function",
      name: INTERNAL_WEB_SEARCH_TOOL_NAME,
    });
  });

  it("replays only genuine Responses opaque reasoning and drops cross-protocol reasoning", () => {
    const encoded = encodeResponsesRequest(
      baseRequest({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                id: "rs_real",
                text: "openai summary",
                signature: "must-not-leak-openai-signature",
                source: "openai-responses",
                opaque: {
                  provider: "openai-responses",
                  kind: "reasoning",
                  value: "real-encrypted-state",
                },
              },
              {
                type: "reasoning",
                text: "anthropic thought",
                signature: "must-not-leak-anthropic-signature",
                source: "anthropic",
                opaque: { provider: "anthropic", kind: "signature", value: "anthropic-opaque" },
              },
              {
                type: "reasoning",
                text: "synthetic thought",
                source: "openai-responses",
                opaque: {
                  provider: "openai-responses",
                  kind: "reasoning",
                  value: "synthetic-opaque",
                  synthetic: true,
                },
              },
            ],
          },
        ],
        stopSequences: ["ignored"],
      }),
      { store: true, promptCache: noPromptCache },
    );

    expect(encoded.input).toEqual([
      {
        id: "rs_real",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "openai summary" }],
        encrypted_content: "real-encrypted-state",
      },
    ]);
    expect(encoded).not.toHaveProperty("stop");
    expect(JSON.stringify(encoded)).not.toContain("signature");
    expect(JSON.stringify(encoded)).not.toContain("anthropic-opaque");
    expect(JSON.stringify(encoded)).not.toContain("synthetic-opaque");
  });

  it("decodes every ordered output item, citations, opaque reasoning, tools, and usage", () => {
    expect(
      decodeResponsesResponse({
        id: "resp_1",
        model: "gpt-test",
        status: "completed",
        incomplete_details: null,
        output: [
          {
            type: "reasoning",
            id: "rs_1",
            summary: [
              { type: "summary_text", text: "step one" },
              { type: "summary_text", text: " then two" },
            ],
            encrypted_content: "encrypted-state",
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "first",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.test/source",
                    title: "Source",
                    start_index: 0,
                    end_index: 5,
                  },
                ],
              },
              { type: "output_text", text: "second", annotations: [] },
            ],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "weather",
            arguments: '{"city":"Paris"}',
          },
          { type: "function_call", call_id: "call_2", name: "time", arguments: "{}" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "after", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 8,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ).toEqual({
      id: "resp_1",
      model: "gpt-test",
      content: [
        {
          type: "reasoning",
          id: "rs_1",
          text: "step one then two",
          source: "openai-responses",
          opaque: {
            provider: "openai-responses",
            kind: "reasoning",
            value: "encrypted-state",
          },
        },
        {
          type: "text",
          text: "first",
          citations: [
            {
              type: "url",
              url: "https://example.test/source",
              title: "Source",
              startIndex: 0,
              endIndex: 5,
            },
          ],
        },
        { type: "text", text: "second" },
        {
          type: "function_call",
          id: "call_1",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
        { type: "function_call", id: "call_2", name: "time", arguments: "{}" },
        { type: "text", text: "after" },
      ],
      finishReason: "tool_use",
      usage: {
        inputTokens: 20,
        outputTokens: 8,
        cacheReadInputTokens: 6,
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
      },
    });
  });

  it("maps incomplete and refusal finishes", () => {
    expect(
      decodeResponsesResponse({
        id: "resp_limit",
        model: "gpt-test",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
        usage: { input_tokens: 1, output_tokens: 2 },
      }).finishReason,
    ).toBe("max_tokens");

    expect(
      decodeResponsesResponse({
        id: "resp_refusal",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "cannot comply" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    ).toMatchObject({
      content: [{ type: "refusal", refusal: "cannot comply" }],
      finishReason: "refusal",
    });
  });

  it("rejects unknown user-visible Responses output instead of dropping it", () => {
    expect(() =>
      decodeResponsesResponse({
        id: "resp_unknown",
        model: "gpt-test",
        status: "completed",
        output: [{ type: "computer_call", id: "computer_1" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/Unsupported OpenAI Responses output item/);
    expect(() =>
      decodeResponsesResponse({
        id: "resp_unknown_content",
        model: "gpt-test",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "audio", data: "secret-audio" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toThrow(/Unsupported OpenAI Responses message content/);
  });

  it("rejects malformed Responses bodies without exposing them", () => {
    const secret = "upstream-secret-body";
    let thrown: unknown;
    try {
      decodeResponsesResponse({
        id: "resp_bad",
        model: "gpt-test",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: { secret } }] }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "OpenAIAdapterError",
      code: "INVALID_OPENAI_RESPONSES_RESPONSE",
    });
    expect(String(thrown)).not.toContain(secret);
  });
});

describe("OpenAI Chat adapter", () => {
  it.each([
    "xhigh",
    null,
  ] as const)("encodes canonical effort %s as reasoning_effort", (reasoningEffort) => {
    expect(encodeChatRequest(baseRequest({ reasoningEffort }))).toHaveProperty(
      "reasoning_effort",
      reasoningEffort,
    );
  });

  it("omits reasoning_effort when canonical effort is absent", () => {
    expect(encodeChatRequest(baseRequest())).not.toHaveProperty("reasoning_effort");
  });

  it("materializes built-in Web Search as the reserved upstream Chat function", () => {
    const encoded = encodeChatRequest(
      baseRequest({
        tools: [{ type: "web_search", provider: "web-search", version: "web_search" }],
        toolChoice: { type: "function", name: "web_search" },
      }),
    );

    expect(encoded.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: INTERNAL_WEB_SEARCH_TOOL_NAME,
          parameters: INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
          strict: true,
        }),
      }),
    ]);
    expect(encoded.tool_choice).toEqual({
      type: "function",
      function: { name: INTERNAL_WEB_SEARCH_TOOL_NAME },
    });
  });

  it("encodes multimodal messages, reasoning extension, parallel tools, results, and stop", () => {
    const encoded = encodeChatRequest(
      baseRequest({
        maxOutputTokens: 256,
        messages: [
          { role: "developer", content: [{ type: "text", text: "instructions" }] },
          {
            role: "user",
            content: [
              { type: "text", text: "inspect" },
              {
                type: "image",
                source: { type: "base64", mediaType: "image/jpeg", data: "aW1hZ2U=" },
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "reasoning extension",
                signature: "must-not-leak-chat-signature",
                source: "anthropic",
                opaque: { provider: "anthropic", kind: "signature", value: "opaque-signature" },
              },
              { type: "text", text: "calling" },
              { type: "function_call", id: "call_1", name: "weather", arguments: "{}" },
              { type: "function_call", id: "call_2", name: "time", arguments: "{}" },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "function_result", callId: "call_1", output: "sunny", isError: false },
              { type: "function_result", callId: "call_2", output: "12:00", isError: false },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            inputSchema: { type: "object", properties: {} },
            strict: true,
          },
        ],
        toolChoice: { type: "required" },
        parallelToolCalls: true,
        temperature: 0.1,
        topP: 0.8,
        stopSequences: ["END"],
      }),
    );

    expect(encoded).toEqual({
      model: "gpt-test",
      messages: [
        { role: "system", content: [{ type: "text", text: "instructions" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,aW1hZ2U=" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "calling" }],
          reasoning_content: "reasoning extension",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "weather", arguments: "{}" },
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "time", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
        { role: "tool", tool_call_id: "call_2", content: "12:00" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
      tool_choice: "required",
      parallel_tool_calls: true,
      max_completion_tokens: 256,
      stream: false,
      temperature: 0.1,
      top_p: 0.8,
      stop: ["END"],
    });
    expect(JSON.stringify(encoded)).not.toContain("signature");
    expect(JSON.stringify(encoded)).not.toContain("opaque-signature");
  });

  it("decodes reasoning, content, parallel calls, finish, and detailed usage", () => {
    expect(
      decodeChatResponse({
        id: "chatcmpl_1",
        model: "gpt-test",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              reasoning_content: "considered tools",
              content: "I will check.",
              refusal: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "weather", arguments: '{"city":"Paris"}' },
                },
                {
                  id: "call_2",
                  type: "function",
                  function: { name: "time", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ).toEqual({
      id: "chatcmpl_1",
      model: "gpt-test",
      content: [
        { type: "reasoning", text: "considered tools", source: "openai-chat" },
        { type: "text", text: "I will check." },
        {
          type: "function_call",
          id: "call_1",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
        { type: "function_call", id: "call_2", name: "time", arguments: "{}" },
      ],
      finishReason: "tool_use",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 4,
        cacheWriteInputTokens: 2,
        reasoningTokens: 3,
      },
    });
  });

  it("rejects unknown Chat content parts instead of dropping them", () => {
    expect(() =>
      decodeChatResponse({
        id: "chatcmpl_unknown",
        model: "gpt-test",
        choices: [
          {
            finish_reason: "stop",
            message: { content: [{ type: "audio", data: "private-audio" }] },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "OpenAIAdapterError",
        code: "INVALID_OPENAI_CHAT_RESPONSE",
      }),
    );
  });

  it("requires exactly one Chat choice", () => {
    expect(() =>
      decodeChatResponse({
        id: "chatcmpl_bad",
        model: "gpt-test",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ).toThrow(/exactly one choice/);
    expect(() =>
      decodeChatResponse({
        id: "chatcmpl_bad",
        model: "gpt-test",
        choices: [
          { finish_reason: "stop", message: { content: "one" } },
          { finish_reason: "stop", message: { content: "two" } },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ).toThrow(/exactly one choice/);
  });

  it("rejects incomplete tool argument JSON without exposing the body", () => {
    const secret = "chat-secret-body";
    let thrown: unknown;
    try {
      decodeChatResponse({
        id: "chatcmpl_bad",
        model: "gpt-test",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "weather", arguments: `{"secret":"${secret}"` },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "OpenAIAdapterError",
      code: "INVALID_OPENAI_CHAT_RESPONSE",
    });
    expect(String(thrown)).not.toContain(secret);
  });
});
describe("decodeResponsesRequest hardening", () => {
  it("decodes string content messages and accepts an omitted input", () => {
    expect(decodeResponsesRequest({ model: "gpt-test" })).toMatchObject({ messages: [] });
    expect(
      decodeResponsesRequest({
        model: "gpt-test",
        input: [{ type: "message", role: "user", content: "plain" }],
      }),
    ).toMatchObject({
      messages: [{ role: "user", content: [{ type: "text", text: "plain" }] }],
    });
  });

  it.each([
    { input: 5 },
    { input: [42] },
    { input: [{ role: "tool", content: "x" }] },
    { input: [{ role: "user", content: 5 }] },
    { input: [{ role: "user", content: [{ type: "input_text" }] }] },
    {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/tiff;base64,AAAA" }],
        },
      ],
    },
    { input: [{ type: "reasoning", id: "r", summary: "x" }] },
    { input: [{ type: "reasoning", id: "r", summary: [{ type: "text", text: "x" }] }] },
    { input: [{ type: "reasoning", id: "r", summary: [], encrypted_content: 5 }] },
    { input: [{ type: "reasoning", summary: [] }] },
    { input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{" }] },
    { input: [{ type: "function_call_output", call_id: "c", output: 5 }] },
    { input: [{ type: "unsupported_item" }] },
    { tools: "x" },
    { tools: [{ type: "function", name: "f", parameters: {}, description: 1 }] },
    { tools: [{ type: "function", name: "f", parameters: {}, strict: "yes" }] },
    { tools: [{ type: "custom", name: "f", parameters: {} }] },
    { tools: [{ type: "web_search", user_location: { city: 1 } }] },
    { tools: [{ type: "web_search", filters: "x" }] },
    { tool_choice: { type: "other" } },
    { background: "yes" },
    { stream: "yes" },
    { parallel_tool_calls: 1 },
    { instructions: 5 },
    { max_output_tokens: 1.5 },
    { max_output_tokens: -1 },
    { temperature: "hot" },
    { store: "yes" },
    { previous_response_id: 5 },
    { prompt_cache_key: 5 },
    { reasoning: "x" },
    { model: "" },
    { metadata: "x" },
  ])("rejects malformed Responses request %#", (payload) => {
    expect(() => decodeResponsesRequest({ model: "gpt-test", ...payload })).toThrowError(
      expect.objectContaining({
        name: "OpenAIAdapterError",
        code: "INVALID_OPENAI_RESPONSES_REQUEST",
      }),
    );
  });

  it("rejects circular and excessively nested metadata and reasoning", () => {
    const shallow: Record<string, unknown> = {};
    shallow.self = shallow;
    expect(() => decodeResponsesRequest({ model: "gpt-test", metadata: shallow })).toThrowError(
      expect.objectContaining({ name: "OpenAIAdapterError" }),
    );
    expect(() => decodeResponsesRequest({ model: "gpt-test", reasoning: shallow })).toThrowError(
      expect.objectContaining({ name: "OpenAIAdapterError" }),
    );

    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 101; depth += 1) {
      deep = { nested: deep };
    }
    expect(() => decodeResponsesRequest({ model: "gpt-test", metadata: deep })).toThrowError(
      expect.objectContaining({ name: "OpenAIAdapterError" }),
    );
  });
});
describe("decodeResponsesResponse hardening", () => {
  const base = {
    id: "resp_1",
    model: "gpt-test",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("drops non-URL annotations while preserving text", () => {
    const decoded = decodeResponsesResponse({
      ...base,
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "hi",
              annotations: [
                { type: "file_citation", file_id: "f1" },
                { type: "url_citation", url: "https://example.test/s", title: "T" },
              ],
            },
          ],
        },
      ],
    });
    expect(decoded.content).toEqual([
      {
        type: "text",
        text: "hi",
        citations: [{ type: "url", url: "https://example.test/s", title: "T" }],
      },
    ]);
  });

  it("maps a non-completed terminal status to incomplete", () => {
    expect(decodeResponsesResponse({ ...base, status: "failed", output: [] }).finishReason).toBe(
      "incomplete",
    );
  });

  it("validates wire metadata only when preservation is requested", () => {
    const withIncomplete = decodeResponsesResponse(
      { ...base, status: "incomplete", incomplete_details: null, output: [] },
      { preserveWireMetadata: true },
    );
    expect(withIncomplete.extensions?.response).toMatchObject({ incomplete_details: null });

    expect(() =>
      decodeResponsesResponse(
        { ...base, status: "incomplete", incomplete_details: { reason: "weird" }, output: [] },
        { preserveWireMetadata: true },
      ),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));
    expect(() =>
      decodeResponsesResponse(
        { ...base, status: "completed", object: "chat", output: [] },
        { preserveWireMetadata: true },
      ),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));
    expect(() =>
      decodeResponsesResponse(
        { ...base, status: "queued", output: [] },
        { preserveWireMetadata: true },
      ),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));
  });

  it.each([
    { output: "x" },
    { output: [{ type: "message" }] },
    { output: [{ type: "reasoning", id: "r", summary: [{ type: "text", text: "x" }] }] },
    { output: [{ type: "message", role: "assistant", content: [], status: "weird" }] },
    { output: [{ type: "message", role: "user", content: [] }] },
    { output: [], usage: { input_tokens: -1, output_tokens: 1 } },
    { output: [], usage: "x" },
  ])("rejects malformed Responses body %#", (payload) => {
    expect(() =>
      decodeResponsesResponse({ ...base, status: "completed", ...payload }),
    ).toThrowError(
      expect.objectContaining({
        name: "OpenAIAdapterError",
        code: "INVALID_OPENAI_RESPONSES_RESPONSE",
      }),
    );
  });
});
describe("encodeResponsesRequest edge cases", () => {
  it("rejects non-function-result content in tool messages", () => {
    const overrides: Partial<CanonicalRequest>[] = [
      { messages: [{ role: "tool", content: [{ type: "text", text: "x" }] }] },
      { messages: [{ role: "tool", content: [{ type: "refusal", refusal: "no" }] }] },
      {
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "search_result",
                title: "t",
                source: "s",
                content: "snippet",
                citationsEnabled: false,
              },
            ],
          },
        ],
      },
    ];
    for (const extra of overrides) {
      expect(() =>
        encodeResponsesRequest(baseRequest(extra), { store: false, promptCache: noPromptCache }),
      ).toThrowError(
        expect.objectContaining({
          name: "OpenAIAdapterError",
          code: "INVALID_OPENAI_RESPONSES_REQUEST",
        }),
      );
    }
  });

  it("encodes assistant refusals and user search results as text messages and passes through auto tool choice", () => {
    const request = encodeResponsesRequest(
      baseRequest({
        toolChoice: { type: "auto" },
        messages: [
          { role: "assistant", content: [{ type: "refusal", refusal: "cannot" }] },
          { role: "user", content: [{ type: "text", text: "keep me" }] },
          {
            role: "user",
            content: [
              {
                type: "search_result",
                title: "t",
                source: "s",
                content: "snippet",
                citationsEnabled: true,
              },
            ],
          },
        ],
      }),
      { store: false, promptCache: noPromptCache },
    );

    expect(request.tool_choice).toBe("auto");
    expect(request.input).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "input_text", text: "cannot" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep me" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "snippet" }] },
    ]);
  });
});

const messageText: CanonicalResponse["content"][number] = { type: "text", text: "x" };

describe("encodeResponsesResponse edge cases", () => {
  function canonical(
    layout: Array<Record<string, unknown>>,
    content: unknown[],
  ): CanonicalResponse {
    return {
      id: "resp_1",
      model: "gpt-test",
      content: content as CanonicalResponse["content"],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      extensions: {
        source: "openai-responses",
        response: { status: "completed", output_layout: layout, usage: {} },
      },
    };
  }

  it("rejects content that does not match each layout item type", () => {
    const image = { type: "image", source: { type: "url", url: "https://example.test/x.png" } };
    const text = { type: "text", text: "x" };

    expect(() =>
      encodeResponsesResponse(canonical([{ type: "message", contentCount: 1 }], [image])),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));

    expect(() =>
      encodeResponsesResponse(canonical([{ type: "reasoning", contentCount: 1 }], [text])),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));

    expect(() =>
      encodeResponsesResponse(canonical([{ type: "function_call", contentCount: 1 }], [text])),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));
  });

  it("rejects malformed preserved metadata fields", () => {
    expect(() =>
      encodeResponsesResponse(
        canonical([{ type: "message", contentCount: 1, id: 42 }], [messageText]),
      ),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));

    expect(() =>
      encodeResponsesResponse({
        id: "resp_1",
        model: "gpt-test",
        content: [messageText],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        extensions: {
          source: "openai-responses",
          response: {
            status: "completed",
            object: "response",
            created_at: -1,
            output_layout: [{ type: "message", contentCount: 1 }],
            usage: {},
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ name: "OpenAIAdapterError" }));
  });
});
describe("decodeChatResponse hardening", () => {
  const base = {
    id: "chatcmpl_1",
    model: "gpt-test",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };

  it("decodes array content with text and refusal parts and maps finish reasons", () => {
    const decoded = decodeChatResponse({
      ...base,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "a" },
              { type: "refusal", refusal: "r" },
            ],
          },
          finish_reason: "content_filter",
        },
      ],
    });
    expect(decoded.content).toEqual([
      { type: "text", text: "a" },
      { type: "refusal", refusal: "r" },
    ]);
    expect(decoded.finishReason).toBe("refusal");
  });

  it("maps every finish reason", () => {
    const wrap = (finishReason: string, content: unknown = "x") =>
      decodeChatResponse({
        id: "c",
        model: "m",
        choices: [{ index: 0, message: { content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }).finishReason;

    expect(wrap("length")).toBe("max_tokens");
    expect(wrap("content_filter")).toBe("refusal");
    expect(wrap("is_this_a_real_reason")).toBe("incomplete");
    expect(wrap("stop", [{ type: "refusal", refusal: "no" }])).toBe("refusal");
  });

  it("rejects malformed Chat responses", () => {
    const bad = (overrides: Record<string, unknown>) => {
      expect(() =>
        decodeChatResponse({
          id: "chatcmpl_1",
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "x" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          ...overrides,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "OpenAIAdapterError",
          code: "INVALID_OPENAI_CHAT_RESPONSE",
        }),
      );
    };

    bad({ id: 5 });
    bad({ model: 5 });
    bad({ usage: { prompt_tokens: -1, completion_tokens: 1 } });
    bad({
      choices: [{ index: 0, message: { content: 5 }, finish_reason: "stop" }],
    });
    bad({
      choices: [{ index: 0, message: { content: [{ type: "text" }] }, finish_reason: "stop" }],
    });
    bad({
      choices: [{ index: 0, message: { content: [{ type: "refusal" }] }, finish_reason: "stop" }],
    });
    bad({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: "x",
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    bad({
      choices: [
        {
          index: 0,
          message: {
            content: null,
            tool_calls: [{ type: "custom", function: { name: "f", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  });
});

describe("encodeChatRequest edge cases", () => {
  it("encodes URL images and function tool choice", () => {
    const request = encodeChatRequest(
      baseRequest({
        toolChoice: { type: "function", name: "weather" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "https://example.test/i.png" } },
            ],
          },
        ],
      }),
    );

    expect(request.tool_choice).toEqual({ type: "function", function: { name: "weather" } });
    expect(request.messages[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.test/i.png" } }],
    });
  });

  it("rejects non-function-result content in Chat tool messages", () => {
    expect(() =>
      encodeChatRequest(
        baseRequest({ messages: [{ role: "tool", content: [{ type: "text", text: "x" }] }] }),
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "OpenAIAdapterError",
        code: "INVALID_OPENAI_CHAT_REQUEST",
      }),
    );
  });

  it("degrades user search_result blocks to plain text instead of dropping them", () => {
    const request = encodeChatRequest(
      baseRequest({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "search_result",
                title: "Doc",
                source: "https://example.test",
                content: "snippet text",
                citationsEnabled: false,
              },
              { type: "text", text: "question" },
            ],
          },
        ],
      }),
    );

    expect(request.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "snippet text" },
        { type: "text", text: "question" },
      ],
    });
  });
});
it("decodes the top-level Chat refusal field and rejects non-object bodies", () => {
  const decoded = decodeChatResponse({
    id: "chatcmpl_1",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "sorry", refusal: "cannot help" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  expect(decoded.content).toEqual([
    { type: "text", text: "sorry" },
    { type: "refusal", refusal: "cannot help" },
  ]);

  expect(() => decodeChatResponse(null)).toThrowError(
    expect.objectContaining({ name: "OpenAIAdapterError", code: "INVALID_OPENAI_CHAT_RESPONSE" }),
  );
});

it("decodes string tool_choice values on the Responses request", () => {
  for (const value of ["auto", "none", "required"]) {
    expect(decodeResponsesRequest({ model: "gpt-test", tool_choice: value })).toMatchObject({
      toolChoice: { type: value },
    });
  }
});
