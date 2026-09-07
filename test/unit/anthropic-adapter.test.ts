import { describe, expect, it, vi } from "vitest";
import type { CanonicalResponse } from "../../src/core/ir.js";
import {
  AnthropicDecodeError,
  decodeAnthropicRequest,
  decodeAnthropicRequestWithSidecar,
  decodeAnthropicTokenCountRequest,
} from "../../src/protocols/anthropic/decode.js";
import {
  AnthropicEncodeError,
  encodeAnthropicResponse,
} from "../../src/protocols/anthropic/encode.js";

describe("decodeAnthropicRequest", () => {
  it.each([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    null,
  ] as const)("decodes output_config effort %s into the canonical request", (effort) => {
    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
        output_config: { effort },
      }),
    ).toMatchObject({ reasoningEffort: effort });
  });

  it("omits canonical effort when output_config or effort is absent", () => {
    const withoutOutputConfig = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
    });
    const withoutEffort = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 64,
      messages: [{ role: "user", content: "Hello" }],
      output_config: {},
    });

    expect(withoutOutputConfig).not.toHaveProperty("reasoningEffort");
    expect(withoutEffort).not.toHaveProperty("reasoningEffort");
  });

  it("treats output_config format null as no format constraint", () => {
    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
        output_config: { effort: "high", format: null },
      }),
    ).toMatchObject({ reasoningEffort: "high" });
  });

  it.each([
    null,
    [],
    "high",
    { effort: "none" },
    { effort: "minimal" },
    { effort: 1 },
    { effort: "high", format: { type: "json_schema" } },
    { effort: "high", unknown_control: true },
  ])("rejects malformed output_config %#", (outputConfig) => {
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 64,
        messages: [{ role: "user", content: "Hello" }],
        output_config: outputConfig,
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("decodes string system and message content while preserving request options", () => {
    const metadata = { user_id: "opaque-user", trace: { sampled: true } };

    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 512,
        system: "Be concise.",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.3,
        top_p: 0.9,
        top_k: 20,
        stop_sequences: ["STOP"],
        thinking: { type: "enabled", budget_tokens: 128 },
        metadata,
        ignored_future_field: "ignored",
      }),
    ).toEqual({
      source: "anthropic",
      model: "claude-test",
      maxOutputTokens: 512,
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [],
      temperature: 0.3,
      topP: 0.9,
      stopSequences: ["STOP"],
      stream: false,
      metadata,
      extensions: {
        source: "anthropic",
        request: {
          top_k: 20,
          thinking: { type: "enabled", budget_tokens: 128 },
        },
      },
    });
  });

  it("places system blocks first and preserves all block ordering", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 64,
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            {
              type: "image",
              source: { type: "url", url: "https://example.test/image.png" },
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "cG5n" },
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    });

    expect(decoded.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image",
            source: { type: "url", url: "https://example.test/image.png" },
          },
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "cG5n" },
          },
          { type: "text", text: "after" },
        ],
      },
    ]);
  });

  it("distinguishes built-in Web Search from a function with the same name", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [{ role: "user", content: "search" }],
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 2 },
        {
          type: "custom",
          name: "web_search",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    });

    expect(decoded.tools).toEqual([
      {
        type: "web_search",
        provider: "web-search",
        version: "web_search_20250305",
        maxUses: 2,
      },
      {
        type: "function",
        name: "web_search",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        strict: false,
      },
    ]);
  });

  it("recognizes every locked-SDK Anthropic Web Search discriminator", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [{ role: "user", content: "search" }],
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_search_20260318", name: "web_search", response_inclusion: "excluded" },
      ],
    });

    expect(decoded.tools).toEqual([
      { type: "web_search", provider: "web-search", version: "web_search_20250305" },
      { type: "web_search", provider: "web-search", version: "web_search_20260209" },
      { type: "web_search", provider: "web-search", version: "web_search_20260318" },
    ]);
  });

  it("rejects unknown and malformed built-in Web Search declarations", () => {
    const malformedTools = [
      { type: "web_search_20990101", name: "web_search" },
      { type: "web_search_20250305", name: "web_search", max_uses: "many" },
      {
        type: "web_search_20260209",
        name: "web_search",
        response_inclusion: "excluded",
      },
      {
        type: "web_search_20260318",
        name: "web_search",
        response_inclusion: "summary",
      },
      { type: "web_search_20250305", name: "web_search", allowed_domains: "example.test" },
      {
        type: "web_search_20250305",
        name: "web_search",
        allowed_domains: ["allowed.example"],
        blocked_domains: ["blocked.example"],
      },
      {
        type: "web_search_20250305",
        name: "web_search",
        user_location: { type: "exact", city: "Paris" },
      },
    ];

    for (const tool of malformedTools) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 128,
          messages: [{ role: "user", content: "search" }],
          tools: [tool],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it("extracts validated prompt-cache markers into a restricted positional sidecar", () => {
    const decoded = decodeAnthropicRequestWithSidecar({
      model: "claude-test",
      max_tokens: 128,
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: "tail" },
      ],
      tools: [
        {
          name: "weather",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
    });

    expect(decoded.promptCache).toEqual({
      input: {
        tools: [{ id: "tool:0", explicitBreakpoint: true }],
        system: [{ id: "system:0", explicitBreakpoint: true }],
        messages: [{ id: "message:0", explicitBreakpoint: true }, { id: "message:1" }],
      },
      explicitMarkers: [
        { nodeId: "tool:0", marker: { type: "ephemeral", ttl: "5m" } },
        { nodeId: "system:0", marker: { type: "ephemeral", ttl: "1h" } },
        { nodeId: "message:0", marker: { type: "ephemeral" } },
      ],
    });
    expect(decoded.request).toEqual(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 128,
        system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
          },
          { role: "user", content: "tail" },
        ],
        tools: [
          {
            name: "weather",
            input_schema: { type: "object" },
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      }),
    );
    expect(JSON.stringify(decoded.request)).not.toContain("cache_control");
    expect(decoded.request.extensions).toBeUndefined();
  });

  it("rejects malformed prompt-cache markers without exposing their content", () => {
    const secret = "private-cache-value";

    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        system: [
          {
            type: "text",
            text: secret,
            cache_control: { type: "ephemeral", ttl: "forever" },
          },
        ],
        messages: [],
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "history",
                cache_control: { type: "ephemeral", private_hint: secret },
              },
            ],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);

    try {
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        messages: [],
        tools: [
          {
            name: "weather",
            input_schema: { type: "object" },
            cache_control: { type: secret },
          },
        ],
      });
      throw new Error("Expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicDecodeError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it("preserves terminal nested tool-result markers and rejects unrepresentable placements", () => {
    const decoded = decodeAnthropicRequestWithSidecar({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                { type: "text", text: "first" },
                {
                  type: "text",
                  text: "last",
                  cache_control: { type: "ephemeral", ttl: "1h" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(decoded.promptCache.explicitMarkers).toEqual([
      { nodeId: "message:0", marker: { type: "ephemeral", ttl: "1h" } },
    ]);

    const secret = "private-marker";
    for (const content of [
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "first", cache_control: { type: "ephemeral" } },
            { type: "text", text: "last" },
          ],
        },
      ],
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "last", cache_control: { type: secret } }],
        },
      ],
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          cache_control: { type: "ephemeral" },
          content: [{ type: "text", text: "last", cache_control: { type: "ephemeral" } }],
        },
      ],
      [
        {
          type: "thinking",
          thinking: "reason",
          signature: "signed",
          cache_control: { type: "ephemeral" },
        },
      ],
    ]) {
      let thrown: unknown;
      try {
        decodeAnthropicRequestWithSidecar({
          model: "claude-test",
          max_tokens: 128,
          messages: [{ role: content[0]?.type === "thinking" ? "assistant" : "user", content }],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AnthropicDecodeError);
      expect(String(thrown)).not.toContain(secret);
    }
  });

  it("decodes custom tools, tool calls, and tool choice parallelism", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "weather",
              input: { city: "Paris", units: null },
            },
          ],
        },
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          strict: true,
        },
      ],
      tool_choice: {
        type: "tool",
        name: "weather",
        disable_parallel_tool_use: true,
      },
    });

    expect(decoded.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking" },
          {
            type: "function_call",
            id: "toolu_1",
            name: "weather",
            arguments: '{"city":"Paris","units":null}',
          },
        ],
      },
    ]);
    expect(decoded.tools).toEqual([
      {
        type: "function",
        name: "weather",
        description: "Get weather",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        strict: true,
      },
    ]);
    expect(decoded.toolChoice).toEqual({ type: "function", name: "weather" });
    expect(decoded.parallelToolCalls).toBe(false);
  });

  it("turns each tool result into a tool message with joined text and colocated images", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "tool_result", tool_use_id: "toolu_1", content: "sunny" },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: [
                { type: "text", text: "line 1" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: "anBn" },
                },
                { type: "text", text: "\nline 2" },
              ],
            },
            { type: "text", text: "after" },
          ],
        },
      ],
    });

    expect(decoded.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "before" }] },
      {
        role: "tool",
        content: [{ type: "function_result", callId: "toolu_1", output: "sunny", isError: false }],
      },
      {
        role: "tool",
        content: [
          {
            type: "function_result",
            callId: "toolu_2",
            output: "line 1\nline 2",
            isError: true,
          },
          {
            type: "image",
            source: { type: "base64", mediaType: "image/jpeg", data: "anBn" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ]);
  });

  it("accepts unsigned thinking in a tool roundtrip", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "user", content: "use sleep" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan", signature: "" },
            { type: "text", text: "calling" },
            {
              type: "tool_use",
              id: "call_1",
              name: "sleep",
              input: { seconds: 3 },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }],
        },
      ],
      tools: [
        {
          name: "sleep",
          input_schema: {
            type: "object",
            properties: { seconds: { type: "number" } },
          },
        },
      ],
    });

    expect(decoded.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "use sleep" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "plan", source: "anthropic" },
          { type: "text", text: "calling" },
          {
            type: "function_call",
            id: "call_1",
            name: "sleep",
            arguments: '{"seconds":3}',
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "function_result", callId: "call_1", output: "done", isError: false }],
      },
    ]);
  });

  it("preserves signed thinking and maps existing search results", () => {
    const decoded = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reason", signature: "signed" },
            {
              type: "search_result",
              title: "Result",
              source: "https://example.test/result",
              content: [
                { type: "text", text: "part one" },
                { type: "text", text: " part two" },
              ],
              citations: { enabled: true },
            },
          ],
        },
      ],
    });

    expect(decoded.messages[0]?.content).toEqual([
      {
        type: "reasoning",
        text: "reason",
        signature: "signed",
        source: "anthropic",
      },
      {
        type: "search_result",
        title: "Result",
        source: "https://example.test/result",
        content: "part one part two",
        citationsEnabled: true,
      },
    ]);
  });

  it("rejects unsupported and malformed blocks without exposing their content", () => {
    const secret = "private-document-contents";

    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [
          {
            role: "user",
            content: [{ type: "document", source: { type: "text", data: secret } }],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);

    try {
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: [{ type: "audio", data: secret }] }],
      });
      throw new Error("Expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicDecodeError);
      if (error instanceof AnthropicDecodeError) {
        expect(error.code).toBe("unsupported_content");
        expect(error.message).toBe("Unsupported Anthropic content block");
        expect(error.message).not.toContain(secret);
      }
    }
  });

  it("rejects excessive JSON nesting without overflowing the stack", () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 101; depth += 1) {
      nested = { nested };
    }

    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        metadata: nested,
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("strictly validates roles, IDs, and JSON values", () => {
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "system", content: "not allowed here" }],
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "", name: "tool", input: {} }],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "tool", input: { value: Number.NaN } },
            ],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("rejects circular and non-JSON values in metadata, schemas, and tool inputs", () => {
    const circularMetadata: Record<string, unknown> = {};
    circularMetadata.self = circularMetadata;
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        metadata: circularMetadata,
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        metadata: { callback: () => undefined },
      }),
    ).toThrowError(AnthropicDecodeError);

    const circularSchema: Record<string, unknown> = { type: "object" };
    circularSchema.properties = circularSchema;
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        tools: [{ name: "weather", input_schema: circularSchema }],
      }),
    ).toThrowError(AnthropicDecodeError);

    const circularInput: Record<string, unknown> = {};
    circularInput.nested = circularInput;
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "weather", input: circularInput }],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it.each([
    { type: "disabled" },
    { type: "adaptive" },
    { type: "adaptive", display: "summarized" },
    { type: "adaptive", display: null },
    { type: "enabled", budget_tokens: 128, display: "omitted" },
  ])("preserves thinking config %# in the extension request", (thinking) => {
    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello" }],
        thinking,
      }),
    ).toMatchObject({ extensions: { source: "anthropic", request: { thinking } } });
  });

  it.each([
    "enabled",
    { type: "auto" },
    { type: "enabled" },
    { type: "enabled", budget_tokens: -1 },
    { type: "enabled", budget_tokens: 1.5 },
    { type: "enabled", budget_tokens: Number.NaN },
    { type: "enabled", budget_tokens: 8, display: "verbose" },
    { type: "adaptive", display: "full" },
  ])("rejects malformed thinking config %#", (thinking) => {
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 256,
        messages: [{ role: "user", content: "Hello" }],
        thinking,
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("accepts fully specified Web Search options and rejects malformed ones", () => {
    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
            strict: true,
            defer_loading: true,
            allowed_callers: ["direct", "code_execution_20250825"],
            user_location: { type: "approximate", city: "Paris", country: "FR" },
            cache_control: { type: "ephemeral" },
          },
        ],
      }).tools,
    ).toEqual([
      { type: "web_search", provider: "web-search", version: "web_search_20250305", maxUses: 3 },
    ]);

    const malformedOptions: Record<string, unknown>[] = [
      { name: "not_web_search" },
      { user_location: "Paris" },
      { user_location: { type: "exact" } },
      { user_location: { type: "approximate", city: 7 } },
      { allowed_callers: "direct" },
      { allowed_callers: ["root"] },
      { allowed_callers: ["direct", 42] },
      { strict: "yes" },
      { defer_loading: 1 },
    ];
    for (const overrides of malformedOptions) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 32,
          messages: [],
          tools: [{ type: "web_search_20250305", name: "web_search", ...overrides }],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it.each([
    { temperature: "hot" },
    { temperature: Number.NaN },
    { top_p: Number.POSITIVE_INFINITY },
    { top_k: "10" },
    { stop_sequences: "STOP" },
    { stop_sequences: ["ok", 2] },
    { stream: "yes" },
    { messages: "hi" },
    { messages: [42] },
    { messages: [{ role: "user", content: 42 }] },
    { tools: "weather" },
    { model: "" },
    { metadata: [] },
    { metadata: "x" },
  ])("rejects malformed request fields %#", (overrides) => {
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [{ role: "user", content: "Hello" }],
        ...overrides,
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("rejects malformed image blocks", () => {
    const malformedBlocks: Record<string, unknown>[] = [
      { type: "image" },
      { type: "image", source: "url" },
      { type: "image", source: { type: "base64", media_type: "image/tiff", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/png" } },
      { type: "image", source: { type: "token", token: "abc" } },
      { type: "image", source: { type: "url" } },
    ];
    for (const block of malformedBlocks) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: [block] }],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it("accepts every supported base64 image media type", () => {
    const request = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/gif", data: "R2lm" } },
            {
              type: "image",
              source: { type: "base64", media_type: "image/webp", data: "d2VicA==" },
            },
          ],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", mediaType: "image/gif", data: "R2lm" } },
      { type: "image", source: { type: "base64", mediaType: "image/webp", data: "d2VicA==" } },
    ]);
  });

  it("rejects malformed regular blocks", () => {
    for (const content of [[42], [{}], [{ type: "text" }]]) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content }],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it.each([
    {
      role: "assistant",
      content: [{ type: "image", source: { type: "url", url: "https://example.test/x.png" } }],
    },
    { role: "user", content: [{ type: "thinking", thinking: "hmm" }] },
    { role: "user", content: [{ type: "tool_use", id: "toolu_1", name: "weather", input: {} }] },
    {
      role: "assistant",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
    },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: 7 }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "", input: {} }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "weather" }] },
  ])("rejects misplaced or malformed role content %#", (message) => {
    expect(() =>
      decodeAnthropicRequest({ model: "claude-test", max_tokens: 32, messages: [message] }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("rejects malformed search result blocks", () => {
    const malformedBlocks: Record<string, unknown>[] = [
      { type: "search_result", title: "t", source: "s" },
      { type: "search_result", title: "t", source: "s", content: [{ type: "image" }] },
      { type: "search_result", source: "s", content: [] },
      { type: "search_result", title: "t", content: [] },
      { type: "search_result", title: "t", source: "s", content: [], citations: "yes" },
      {
        type: "search_result",
        title: "t",
        source: "s",
        content: [],
        citations: { enabled: "true" },
      },
    ];
    for (const block of malformedBlocks) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: [block] }],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it("decodes search results with default citation state", () => {
    const request = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "search_result",
              title: "Doc",
              source: "https://example.test",
              content: [{ type: "text", text: "snippet" }],
            },
          ],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      {
        type: "search_result",
        title: "Doc",
        source: "https://example.test",
        content: "snippet",
        citationsEnabled: false,
      },
    ]);
  });

  it.each([
    5,
    null,
    ["text"],
    [{ type: "image", source: { type: "url", url: "https://example.test/x.png" } }],
    [{ type: "text" }],
  ])("rejects malformed system prompts %#", (system) => {
    expect(() =>
      decodeAnthropicRequest({ model: "claude-test", max_tokens: 32, messages: [], system }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("rejects malformed custom tools", () => {
    const malformedTools: unknown[][] = [
      [42],
      [{ name: "weather" }],
      [{ name: "weather", input_schema: [] }],
      [{ name: "weather", input_schema: {}, description: 1 }],
      [{ name: "weather", input_schema: {}, strict: "yes" }],
      [{ name: "weather", input_schema: {}, type: "other" }],
    ];
    for (const tools of malformedTools) {
      expect(() =>
        decodeAnthropicRequest({ model: "claude-test", max_tokens: 32, messages: [], tools }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it("rejects malformed tool result payloads", () => {
    const malformedBlocks: Record<string, unknown>[] = [
      { type: "tool_result", tool_use_id: "toolu_1", is_error: "yes" },
      { type: "tool_result", tool_use_id: "toolu_1", content: 5 },
      { type: "tool_result", tool_use_id: "toolu_1", content: [42] },
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text" }] },
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "document" }] },
    ];
    for (const block of malformedBlocks) {
      expect(() =>
        decodeAnthropicRequest({
          model: "claude-test",
          max_tokens: 32,
          messages: [{ role: "user", content: [block] }],
        }),
      ).toThrowError(AnthropicDecodeError);
    }
  });

  it("decodes tool results with defaults and nested search results", () => {
    const request = decodeAnthropicRequest({
      model: "claude-test",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1" },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [
                {
                  type: "search_result",
                  title: "Doc",
                  source: "https://example.test",
                  content: [{ type: "text", text: "snippet" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(request.messages).toEqual([
      {
        role: "tool",
        content: [{ type: "function_result", callId: "toolu_1", output: "", isError: false }],
      },
      {
        role: "tool",
        content: [
          { type: "function_result", callId: "toolu_2", output: "", isError: false },
          {
            type: "search_result",
            title: "Doc",
            source: "https://example.test",
            content: "snippet",
            citationsEnabled: false,
          },
        ],
      },
    ]);
  });

  it.each([
    "auto",
    { type: "none", disable_parallel_tool_use: true },
    { type: "auto", disable_parallel_tool_use: "no" },
    { type: "tool" },
    { type: "sometimes" },
  ])("rejects malformed tool choice %#", (toolChoice) => {
    expect(() =>
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        tool_choice: toolChoice,
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it.each([
    [{ type: "auto" }, { toolChoice: { type: "auto" } }],
    [{ type: "none" }, { toolChoice: { type: "none" } }],
    [{ type: "any" }, { toolChoice: { type: "required" } }],
    [
      { type: "any", disable_parallel_tool_use: true },
      { toolChoice: { type: "required" }, parallelToolCalls: false },
    ],
  ])("decodes tool choice variants %#", (toolChoice, expected) => {
    expect(
      decodeAnthropicRequest({
        model: "claude-test",
        max_tokens: 32,
        messages: [],
        tool_choice: toolChoice,
      }),
    ).toMatchObject(expected);
  });

  it.each([
    "32",
    -1,
    1.5,
    undefined,
  ])("rejects invalid max_tokens %s in sidecar decode", (maxTokens) => {
    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: maxTokens,
        messages: [],
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("rejects non-record requests in sidecar decode", () => {
    expect(() => decodeAnthropicRequestWithSidecar(null)).toThrowError(AnthropicDecodeError);
    expect(() => decodeAnthropicRequestWithSidecar([1, 2])).toThrowError(AnthropicDecodeError);
  });

  it("rejects cache markers on thinking blocks and non-terminal blocks", () => {
    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "hmm", cache_control: { type: "ephemeral" } }],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
              { type: "text", text: "uncached tail" },
            ],
          },
        ],
      }),
    ).toThrowError(AnthropicDecodeError);

    expect(() =>
      decodeAnthropicRequestWithSidecar({
        model: "claude-test",
        max_tokens: 128,
        system: [{ type: "text", text: "sys", cache_control: "ephemeral" }],
        messages: [],
      }),
    ).toThrowError(AnthropicDecodeError);
  });

  it("counts empty-content messages without producing markers", () => {
    const decoded = decodeAnthropicRequestWithSidecar({
      model: "claude-test",
      max_tokens: 128,
      messages: [
        { role: "user", content: [] },
        { role: "user", content: "Hello" },
      ],
    });

    expect(decoded.request.messages).toHaveLength(2);
    expect(decoded.promptCache.explicitMarkers).toEqual([]);
  });
});

describe("decodeAnthropicTokenCountRequest", () => {
  it("decodes count requests without requiring max_tokens", () => {
    const request = decodeAnthropicTokenCountRequest({
      model: "claude-test",
      system: "Be concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "weather", input_schema: { type: "object" } }],
    });

    expect(request).toMatchObject({
      source: "anthropic",
      model: "claude-test",
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise." }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [{ type: "function", name: "weather" }],
      stream: false,
    });
    expect(request).not.toHaveProperty("maxOutputTokens");
  });

  it("rejects non-record and malformed count requests", () => {
    expect(() => decodeAnthropicTokenCountRequest(null)).toThrowError(AnthropicDecodeError);
    expect(() => decodeAnthropicTokenCountRequest({ model: "claude-test" })).toThrowError(
      AnthropicDecodeError,
    );
    expect(() =>
      decodeAnthropicTokenCountRequest({
        model: "claude-test",
        messages: [{ role: "user", content: [{ type: "audio", data: "x" }] }],
      }),
    ).toThrowError(AnthropicDecodeError);
  });
});

describe("encodeAnthropicResponse", () => {
  it("encodes ordered content, stop data, citations, and cache-aware usage", () => {
    const response: CanonicalResponse = {
      id: "msg_1",
      model: "claude-test",
      content: [
        { type: "reasoning", text: "reason", signature: "signed", source: "anthropic" },
        {
          type: "text",
          text: "answer from source",
          citations: [
            {
              type: "url",
              url: "https://example.test/source",
              title: "Source",
              startIndex: 7,
              endIndex: 18,
            },
          ],
        },
        { type: "function_call", id: "toolu_1", name: "weather", arguments: '{"city":"Paris"}' },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/result.png" },
        },
        {
          type: "search_result",
          title: "Result",
          source: "https://example.test/result",
          content: "result text",
          citationsEnabled: true,
        },
      ],
      finishReason: "stop_sequence",
      stopSequence: "STOP",
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 20,
      },
    };

    expect(encodeAnthropicResponse(response)).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "thinking", thinking: "reason", signature: "signed" },
        {
          type: "text",
          text: "answer from source",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.test/source",
              title: "Source",
              cited_text: "from source",
              encrypted_index: "",
            },
          ],
        },
        { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Paris" } },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/result.png" },
        },
        {
          type: "search_result",
          title: "Result",
          source: "https://example.test/result",
          content: [{ type: "text", text: "result text" }],
          citations: { enabled: true },
        },
      ],
      stop_reason: "stop_sequence",
      stop_sequence: "STOP",
      usage: {
        input_tokens: 50,
        output_tokens: 25,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      },
    });
  });

  it("omits cache usage fields and clamps uncached input tokens to zero", () => {
    const response: CanonicalResponse = {
      id: "msg_2",
      model: "claude-test",
      content: [{ type: "text", text: "done" }],
      finishReason: "end_turn",
      usage: { inputTokens: -1, outputTokens: 1 },
    };

    expect(encodeAnthropicResponse(response).usage).toEqual({
      input_tokens: 0,
      output_tokens: 1,
    });
  });

  it("allows unsigned thinking and applies an optional thinking finalizer", () => {
    const response: CanonicalResponse = {
      id: "msg_3",
      model: "claude-test",
      content: [{ type: "reasoning", text: "reason", source: "openai-responses" }],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    const finalizeThinking = vi.fn((reasoning: (typeof response.content)[number]) => {
      if (reasoning.type !== "reasoning") {
        throw new Error("Unexpected content");
      }
      return { text: reasoning.text, signature: "synthetic" };
    });

    expect(encodeAnthropicResponse(response).content).toEqual([
      { type: "thinking", thinking: "reason" },
    ]);
    expect(encodeAnthropicResponse(response, { finalizeThinking }).content).toEqual([
      { type: "thinking", thinking: "reason", signature: "synthetic" },
    ]);
    expect(finalizeThinking).toHaveBeenCalledOnce();
  });

  it("rejects malformed function arguments with a safe custom error", () => {
    const response: CanonicalResponse = {
      id: "msg_4",
      model: "claude-test",
      content: [
        {
          type: "function_call",
          id: "toolu_1",
          name: "weather",
          arguments: '{"secret":"do-not-leak"',
        },
      ],
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(() => encodeAnthropicResponse(response)).toThrowError(AnthropicEncodeError);
    try {
      encodeAnthropicResponse(response);
      throw new Error("Expected encode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AnthropicEncodeError);
      if (error instanceof AnthropicEncodeError) {
        expect(error).toMatchObject({
          code: "invalid_tool_arguments",
          message: "Function arguments are not valid JSON",
        });
        expect(error.message).not.toContain("do-not-leak");
      }
    }
  });

  it("rejects non-object function arguments", () => {
    for (const argumentsJson of ["null", "[]", '"text"', "42", "true"]) {
      const response: CanonicalResponse = {
        id: "msg_non_object",
        model: "claude-test",
        content: [
          {
            type: "function_call",
            id: "toolu_1",
            name: "weather",
            arguments: argumentsJson,
          },
        ],
        finishReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 2 },
      };

      expect(() => encodeAnthropicResponse(response)).toThrowError(
        expect.objectContaining({
          code: "invalid_tool_arguments",
          message: "Function arguments must contain a JSON object",
        }),
      );
    }
  });

  it("rejects function results in an assistant response", () => {
    const response: CanonicalResponse = {
      id: "msg_5",
      model: "claude-test",
      content: [{ type: "function_result", callId: "toolu_1", output: "result", isError: false }],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(() => encodeAnthropicResponse(response)).toThrowError(AnthropicEncodeError);
  });

  it("encodes citations without optional fields as explicit nulls", () => {
    const response: CanonicalResponse = {
      id: "msg_bare_cite",
      model: "claude-test",
      content: [
        {
          type: "text",
          text: "answer",
          citations: [{ type: "url", url: "https://example.test/source" }],
        },
      ],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(encodeAnthropicResponse(response).content).toEqual([
      {
        type: "text",
        text: "answer",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.test/source",
            title: null,
            cited_text: "answer",
            encrypted_index: "",
          },
        ],
      },
    ]);
  });

  it("encodes base64 image content", () => {
    const response: CanonicalResponse = {
      id: "msg_img",
      model: "claude-test",
      content: [
        { type: "image", source: { type: "base64", mediaType: "image/png", data: "aGVsbG8=" } },
      ],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(encodeAnthropicResponse(response).content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
  });

  it.each([
    { startIndex: -1 },
    { endIndex: 100 },
    { startIndex: 3, endIndex: 1 },
    { startIndex: 0.5, endIndex: 2 },
  ])("rejects out-of-range citation spans %#", (span) => {
    const response: CanonicalResponse = {
      id: "msg_cite",
      model: "claude-test",
      content: [
        {
          type: "text",
          text: "answer",
          citations: [{ type: "url", url: "https://example.test/source", ...span }],
        },
      ],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(() => encodeAnthropicResponse(response)).toThrowError(
      expect.objectContaining({ code: "invalid_response" }),
    );
  });

  it("converts refusal content to a text block and maps incomplete to pause_turn", () => {
    const base: CanonicalResponse = {
      id: "msg_ref",
      model: "claude-test",
      content: [],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    const refusal = encodeAnthropicResponse({
      ...base,
      content: [{ type: "refusal", refusal: "cannot" }],
      finishReason: "refusal",
    });
    expect(refusal.content).toEqual([{ type: "text", text: "cannot" }]);
    expect(refusal.stop_reason).toBe("refusal");

    const incomplete = encodeAnthropicResponse({ ...base, finishReason: "incomplete" });
    expect(incomplete.stop_reason).toBe("pause_turn");
    expect(incomplete.stop_sequence).toBeNull();
  });

  it.each([
    { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: -1 },
    { inputTokens: 5, outputTokens: 1, cacheWriteInputTokens: Number.NaN },
    { inputTokens: 1, outputTokens: -1 },
    { inputTokens: Number.NaN, outputTokens: 1 },
  ])("rejects non-finite or negative usage %#", (usage) => {
    const response: CanonicalResponse = {
      id: "msg_usage",
      model: "claude-test",
      content: [],
      finishReason: "end_turn",
      usage,
    };

    expect(() => encodeAnthropicResponse(response)).toThrowError(
      expect.objectContaining({ code: "invalid_response" }),
    );
  });

  it.each([
    { id: "", model: "claude-test" },
    { id: "msg_1", model: "" },
  ])("requires a response id and model %#", ({ id, model }) => {
    const response: CanonicalResponse = {
      id,
      model,
      content: [],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };

    expect(() => encodeAnthropicResponse(response)).toThrowError(
      expect.objectContaining({ code: "invalid_response" }),
    );
  });

  it("rejects malformed thinking finalizer results", () => {
    const response: CanonicalResponse = {
      id: "msg_think",
      model: "claude-test",
      content: [{ type: "reasoning", text: "reason", source: "openai-responses" }],
      finishReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 2 },
    };

    expect(() =>
      encodeAnthropicResponse(response, {
        finalizeThinking: () => ({ text: 42 as unknown as string }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_response" }));

    expect(() =>
      encodeAnthropicResponse(response, {
        finalizeThinking: () => ({ text: "ok", signature: 7 as unknown as string }),
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });
});
