from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"anchor not found in {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    p = Path(path)
    s = p.read_text()
    start_at = s.find(start)
    if start_at < 0:
        raise SystemExit(f"start anchor not found in {path}: {start!r}")
    end_at = s.find(end, start_at)
    if end_at < 0:
        raise SystemExit(f"end anchor not found in {path}: {end!r}")
    p.write_text(s[:start_at] + replacement + s[end_at:])


# P1: ensure malformed Anthropic request diagnostics only contain bounded structural metadata.
replace_once(
    "src/app.ts",
    "function debugAnthropicBodyShape(body: unknown): Record<string, unknown> {\n",
    '''function debugValueType(value: unknown): string {\n  if (value === null) {\n    return "null";\n  }\n  return Array.isArray(value) ? "array" : typeof value;\n}\n\nfunction debugAnthropicBodyShape(body: unknown): Record<string, unknown> {\n''',
)
replace_once(
    "src/app.ts",
    '''  return {\n    keys: Object.keys(record).sort(),\n    modelType: typeof record.model,\n''',
    '''  const outputConfig =\n    typeof record.output_config === "object" &&\n    record.output_config !== null &&\n    !Array.isArray(record.output_config)\n      ? (record.output_config as Record<string, unknown>)\n      : undefined;\n  return {\n    requestKeyCount: Object.keys(record).length,\n    modelType: typeof record.model,\n''',
)
replace_once(
    "src/app.ts",
    '''    ...(typeof record.output_config === "object" &&\n    record.output_config !== null &&\n    !Array.isArray(record.output_config)\n      ? {\n          outputConfigKeys: Object.keys(record.output_config as Record<string, unknown>).sort(),\n          outputEffort: (record.output_config as Record<string, unknown>).effort,\n          outputFormatType:\n            typeof (record.output_config as Record<string, unknown>).format === "object" &&\n            (record.output_config as Record<string, unknown>).format !== null &&\n            !Array.isArray((record.output_config as Record<string, unknown>).format)\n              ? (\n                  (record.output_config as Record<string, unknown>).format as Record<\n                    string,\n                    unknown\n                  >\n                ).type\n              : typeof (record.output_config as Record<string, unknown>).format,\n        }\n      : {}),\n''',
    '''    ...(outputConfig === undefined\n      ? {}\n      : {\n          outputConfigKeyCount: Object.keys(outputConfig).length,\n          outputConfigHasEffort: Object.hasOwn(outputConfig, "effort"),\n          outputConfigHasFormat: Object.hasOwn(outputConfig, "format"),\n          outputEffortType: debugValueType(outputConfig.effort),\n          outputFormatType: debugValueType(outputConfig.format),\n        }),\n''',
)
replace_once(
    "src/app.ts",
    '''    return {\n      ...(typeof item.instancePath === "string" ? { instancePath: item.instancePath } : {}),\n      ...(typeof item.schemaPath === "string" ? { schemaPath: item.schemaPath } : {}),\n      ...(typeof item.keyword === "string" ? { keyword: item.keyword } : {}),\n      ...(typeof item.message === "string" ? { message: item.message } : {}),\n      ...(params?.missingProperty !== undefined ? { missingProperty: params.missingProperty } : {}),\n      ...(params?.additionalProperty !== undefined\n        ? { additionalProperty: params.additionalProperty }\n        : {}),\n    };\n''',
    '''    return {\n      ...(typeof item.schemaPath === "string" ? { schemaPath: item.schemaPath } : {}),\n      ...(typeof item.keyword === "string" ? { keyword: item.keyword } : {}),\n      hasInstancePath: typeof item.instancePath === "string",\n      hasMessage: typeof item.message === "string",\n      hasMissingProperty: params?.missingProperty !== undefined,\n      hasAdditionalProperty: params?.additionalProperty !== undefined,\n    };\n''',
)

# P2 JSON: native search execution blocks precede the final assistant answer.
replace_once(
    "src/protocols/anthropic/encode.ts",
    '''    content: [\n      ...response.content.map((content) => encodeContent(content, options)),\n      ...encodeWebSearchBlocks(options.webSearchExecutions ?? []),\n    ],\n''',
    '''    content: [\n      ...encodeWebSearchBlocks(options.webSearchExecutions ?? []),\n      ...response.content.map((content) => encodeContent(content, options)),\n    ],\n''',
)

# P2 streaming: reserve prefix indices for native Web Search blocks and emit them after message_start.
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    '''  readonly #argumentLimiter: ToolArgumentStreamLimiter;\n  readonly #outputLimiter: StreamOutputLimiter;\n''',
    '''  readonly #argumentLimiter: ToolArgumentStreamLimiter;\n  readonly #outputLimiter: StreamOutputLimiter;\n  readonly #contentIndexOffset: number;\n''',
)
replace_once(
    "src/protocols/anthropic/stream-encode.ts",
    '''    this.#outputLimiter = new StreamOutputLimiter(\n      options.outputLimits ?? DEFAULT_STREAM_OUTPUT_LIMITS,\n    );\n  }\n''',
    '''    this.#outputLimiter = new StreamOutputLimiter(\n      options.outputLimits ?? DEFAULT_STREAM_OUTPUT_LIMITS,\n    );\n    this.#contentIndexOffset = (options.webSearchExecutions?.length ?? 0) * 2;\n  }\n''',
)

replace_between(
    "src/protocols/anthropic/stream-encode.ts",
    "  encode(event: CanonicalEvent): AnthropicSseFrame[] {\n",
    "  #start(event: Extract<CanonicalEvent, { type: \"response_start\" }>): AnthropicSseFrame[] {\n",
    '''  encode(event: CanonicalEvent): AnthropicSseFrame[] {\n    if (this.#completed) {\n      throw new Error("Anthropic stream is already complete");\n    }\n\n    switch (event.type) {\n      case "response_start":\n        return this.#start(event);\n      case "content_start":\n        return this.#startContent(event.index, event.content);\n      case "text_delta": {\n        this.#assertOpen(event.index, "text");\n        const outputIndex = this.#outputIndex(event.index);\n        this.#outputLimiter.add(outputIndex, event.delta);\n        return [\n          frame("content_block_delta", outputIndex, { type: "text_delta", text: event.delta }),\n        ];\n      }\n      case "reasoning_delta": {\n        this.#assertOpen(event.index, "reasoning");\n        const outputIndex = this.#outputIndex(event.index);\n        this.#outputLimiter.add(outputIndex, event.delta);\n        return [\n          frame("content_block_delta", outputIndex, {\n            type: "thinking_delta",\n            thinking: event.delta,\n          }),\n        ];\n      }\n      case "reasoning_continuation":\n        this.#assertOpen(event.index, "reasoning");\n        return [];\n      case "signature_delta": {\n        const block = this.#assertOpen(event.index, "reasoning");\n        const outputIndex = this.#outputIndex(event.index);\n        this.#outputLimiter.add(outputIndex, event.delta);\n        block.signature += event.delta;\n        return [\n          frame("content_block_delta", outputIndex, {\n            type: "signature_delta",\n            signature: event.delta,\n          }),\n        ];\n      }\n      case "function_arguments_delta": {\n        const block = this.#assertOpen(event.index, "function_call");\n        if (\n          this.options.readToolCompatEnabled === true &&\n          block.content.type === "function_call" &&\n          /^read$/i.test(block.content.name)\n        ) {\n          this.#argumentLimiter.add(event.index, event.delta);\n          block.deltas.push(event.delta);\n          return [];\n        }\n        const outputIndex = this.#outputIndex(event.index);\n        this.#outputLimiter.add(outputIndex, event.delta);\n        return [\n          frame("content_block_delta", outputIndex, {\n            type: "input_json_delta",\n            partial_json: event.delta,\n          }),\n        ];\n      }\n      case "citation_delta": {\n        this.#assertOpen(event.index, "text");\n        const outputIndex = this.#outputIndex(event.index);\n        this.#outputLimiter.addBytes(outputIndex, CITATION_OVERHEAD_BYTES);\n        this.#outputLimiter.addUnrelated(outputIndex, event.citation.url);\n        if (event.citation.title !== undefined) {\n          this.#outputLimiter.addUnrelated(outputIndex, event.citation.title);\n        }\n        return [\n          frame("content_block_delta", outputIndex, {\n            type: "citations_delta",\n            citation: encodeCitation(event.citation),\n          }),\n        ];\n      }\n      case "content_stop":\n        return this.#stopContent(event.index);\n      case "response_complete":\n        return this.#complete(event);\n      case "response_error":\n        this.#assertStarted();\n        this.#completed = true;\n        return [\n          {\n            event: "error",\n            data: {\n              type: "error",\n              error: { type: "api_error", message: event.error.message },\n            },\n          },\n        ];\n    }\n  }\n\n''',
)

replace_between(
    "src/protocols/anthropic/stream-encode.ts",
    "  #start(event: Extract<CanonicalEvent, { type: \"response_start\" }>): AnthropicSseFrame[] {\n",
    "  #startContent(index: number, content: Content): AnthropicSseFrame[] {\n",
    '''  #start(event: Extract<CanonicalEvent, { type: "response_start" }>): AnthropicSseFrame[] {\n    if (this.#started) {\n      throw new Error("Anthropic stream has already started");\n    }\n    this.#started = true;\n    return [\n      {\n        event: "message_start",\n        data: {\n          type: "message_start",\n          message: {\n            id: event.id,\n            type: "message",\n            role: "assistant",\n            model: event.model,\n            content: [],\n            stop_reason: null,\n            stop_sequence: null,\n            usage: { input_tokens: 0, output_tokens: 0 },\n          },\n        },\n      },\n      ...this.#webSearchPrefixFrames(),\n    ];\n  }\n\n''',
)

replace_between(
    "src/protocols/anthropic/stream-encode.ts",
    "  #startContent(index: number, content: Content): AnthropicSseFrame[] {\n",
    "  #stopContent(index: number): AnthropicSseFrame[] {\n",
    '''  #startContent(index: number, content: Content): AnthropicSseFrame[] {\n    this.#assertStarted();\n    if (this.#seenIndices.has(index)) {\n      throw new Error(`Anthropic content block ${index} is already defined`);\n    }\n    this.#seenIndices.add(index);\n    const outputIndex = this.#outputIndex(index);\n    this.#outputLimiter.addBytes(outputIndex, OUTPUT_ITEM_OVERHEAD_BYTES);\n    if (content.type === "function_call") {\n      this.#outputLimiter.addUnrelated(outputIndex, content.id);\n      this.#outputLimiter.addUnrelated(outputIndex, content.name);\n    }\n    const contentBlock = encodeContentStart(content);\n    this.#openBlocks.set(index, {\n      content,\n      deltas: [],\n      signature: content.type === "reasoning" ? (content.signature ?? "") : "",\n    });\n    const frames: AnthropicSseFrame[] = [\n      {\n        event: "content_block_start",\n        data: { type: "content_block_start", index: outputIndex, content_block: contentBlock },\n      },\n    ];\n    if (content.type === "refusal" && content.refusal.length > 0) {\n      this.#outputLimiter.add(outputIndex, content.refusal);\n      frames.push(\n        frame("content_block_delta", outputIndex, {\n          type: "text_delta",\n          text: content.refusal,\n        }),\n      );\n    }\n    return frames;\n  }\n\n''',
)

replace_between(
    "src/protocols/anthropic/stream-encode.ts",
    "  #stopContent(index: number): AnthropicSseFrame[] {\n",
    "  #complete(event: Extract<CanonicalEvent, { type: \"response_complete\" }>): AnthropicSseFrame[] {\n",
    '''  #stopContent(index: number): AnthropicSseFrame[] {\n    this.#assertStarted();\n    const block = this.#openBlocks.get(index);\n    if (!block) {\n      throw new Error(`Anthropic content block ${index} is not open`);\n    }\n\n    const outputIndex = this.#outputIndex(index);\n    const frames: AnthropicSseFrame[] = [];\n    if (\n      block.content.type === "function_call" &&\n      this.options.readToolCompatEnabled === true &&\n      /^read$/i.test(block.content.name)\n    ) {\n      this.#argumentLimiter.finish(index);\n      const normalized = normalizeReadToolArguments(\n        block.content.name,\n        block.deltas.join(""),\n        true,\n      );\n      this.#outputLimiter.add(outputIndex, normalized.json);\n      frames.push(\n        frame("content_block_delta", outputIndex, {\n          type: "input_json_delta",\n          partial_json: normalized.json,\n        }),\n      );\n    } else if (block.content.type === "reasoning" && !block.signature) {\n      const finalized = finalizeThinkingBlock(\n        { text: "" },\n        {\n          enabled: this.options.syntheticThinkingSignatureEnabled === true,\n          ...(this.options.uuidFactory === undefined\n            ? {}\n            : { uuidFactory: this.options.uuidFactory }),\n        },\n      );\n      if ("signature" in finalized) {\n        this.#outputLimiter.add(outputIndex, finalized.signature);\n        frames.push(\n          frame("content_block_delta", outputIndex, {\n            type: "signature_delta",\n            signature: finalized.signature,\n          }),\n        );\n      }\n    }\n\n    this.#openBlocks.delete(index);\n    frames.push({\n      event: "content_block_stop",\n      data: { type: "content_block_stop", index: outputIndex },\n    });\n    return frames;\n  }\n\n  #outputIndex(index: number): number {\n    return index + this.#contentIndexOffset;\n  }\n\n  #webSearchPrefixFrames(): AnthropicSseFrame[] {\n    const frames: AnthropicSseFrame[] = [];\n    for (const [searchIndex, execution] of (this.options.webSearchExecutions ?? []).entries()) {\n      const toolUseId = `srvtoolu_ai_hub_${searchIndex}`;\n      const toolIndex = searchIndex * 2;\n      const resultIndex = toolIndex + 1;\n      const queryJson = JSON.stringify({ query: execution.query });\n\n      this.#outputLimiter.addBytes(toolIndex, OUTPUT_ITEM_OVERHEAD_BYTES);\n      this.#outputLimiter.addUnrelated(toolIndex, toolUseId);\n      this.#outputLimiter.addUnrelated(toolIndex, "web_search");\n      this.#outputLimiter.add(toolIndex, queryJson);\n      frames.push(\n        {\n          event: "content_block_start",\n          data: {\n            type: "content_block_start",\n            index: toolIndex,\n            content_block: { type: "server_tool_use", id: toolUseId, name: "web_search" },\n          },\n        },\n        frame("content_block_delta", toolIndex, {\n          type: "input_json_delta",\n          partial_json: queryJson,\n        }),\n        {\n          event: "content_block_stop",\n          data: { type: "content_block_stop", index: toolIndex },\n        },\n      );\n\n      this.#outputLimiter.addBytes(resultIndex, OUTPUT_ITEM_OVERHEAD_BYTES);\n      this.#outputLimiter.addUnrelated(resultIndex, toolUseId);\n      for (const result of execution.results) {\n        this.#outputLimiter.addBytes(resultIndex, WEB_SEARCH_RESULT_OVERHEAD_BYTES);\n        this.#outputLimiter.addUnrelated(resultIndex, result.title);\n        this.#outputLimiter.addUnrelated(resultIndex, result.url);\n      }\n      frames.push(\n        {\n          event: "content_block_start",\n          data: {\n            type: "content_block_start",\n            index: resultIndex,\n            content_block: {\n              type: "web_search_tool_result",\n              tool_use_id: toolUseId,\n              content: execution.results.map((result) => ({\n                type: "web_search_result",\n                title: result.title,\n                url: result.url,\n              })),\n            },\n          },\n        },\n        {\n          event: "content_block_stop",\n          data: { type: "content_block_stop", index: resultIndex },\n        },\n      );\n    }\n    return frames;\n  }\n\n''',
)

replace_between(
    "src/protocols/anthropic/stream-encode.ts",
    "  #complete(event: Extract<CanonicalEvent, { type: \"response_complete\" }>): AnthropicSseFrame[] {\n",
    "  #assertStarted(): void {\n",
    '''  #complete(event: Extract<CanonicalEvent, { type: "response_complete" }>): AnthropicSseFrame[] {\n    this.#assertStarted();\n    if (this.#openBlocks.size > 0) {\n      throw new Error("Anthropic stream cannot complete with open content blocks");\n    }\n    this.#completed = true;\n    const usage = encodeUsage(event.usage);\n    const webSearchExecutions = this.options.webSearchExecutions ?? [];\n    const nativeResultCount = webSearchExecutions.reduce(\n      (count, execution) => count + execution.results.length,\n      0,\n    );\n    process.stderr.write(\n      `[web-search-debug] ${JSON.stringify({\n        event: "anthropic_stream_complete",\n        canonicalWebSearchRequests: event.usage.webSearchRequests,\n        encodedServerToolUse: usage.server_tool_use,\n        nativeSearchBlocks: webSearchExecutions.length,\n        nativeSearchResults: nativeResultCount,\n      })}\\n`,\n    );\n    if (webSearchExecutions.length > 0) {\n      process.stderr.write(\n        `[web-search-debug] ${JSON.stringify({\n          event: "native_web_search_emitted",\n          searches: webSearchExecutions.length,\n          results: nativeResultCount,\n          queryLengths: webSearchExecutions.map((execution) => execution.query.length),\n        })}\\n`,\n      );\n    }\n    return [\n      {\n        event: "message_delta",\n        data: {\n          type: "message_delta",\n          delta: {\n            stop_reason: encodeStopReason(event.finishReason),\n            stop_sequence: event.stopSequence ?? null,\n          },\n          usage,\n        },\n      },\n      { event: "message_stop", data: { type: "message_stop" } },\n    ];\n  }\n\n''',
)

# Integration ordering assertions for JSON and SSE Web Search output.
replace_once(
    "test/integration/app.test.ts",
    '''        content: [\n          { type: "text", text: "No results found." },\n          {\n            type: "server_tool_use",\n''',
    '''        content: [\n          {\n            type: "server_tool_use",\n''',
)
replace_once(
    "test/integration/app.test.ts",
    '''          {\n            type: "web_search_tool_result",\n            tool_use_id: "srvtoolu_ai_hub_0",\n            content: [],\n          },\n        ],\n        stop_reason: "end_turn",\n''',
    '''          {\n            type: "web_search_tool_result",\n            tool_use_id: "srvtoolu_ai_hub_0",\n            content: [],\n          },\n          { type: "text", text: "No results found." },\n        ],\n        stop_reason: "end_turn",\n''',
)
replace_once(
    "test/integration/app.test.ts",
    '''      expect(response.body).toContain("No results found.");\n      expect(response.body).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);\n''',
    '''      expect(response.body).toContain("No results found.");\n      expect(response.body).not.toContain(INTERNAL_WEB_SEARCH_TOOL_NAME);\n      const searchPosition = response.body.indexOf('"type":"server_tool_use"');\n      const resultPosition = response.body.indexOf('"type":"web_search_tool_result"');\n      const answerPosition = response.body.indexOf("No results found.");\n      expect(searchPosition).toBeGreaterThan(-1);\n      expect(resultPosition).toBeGreaterThan(searchPosition);\n      expect(answerPosition).toBeGreaterThan(resultPosition);\n''',
)

# Privacy regression for malformed request diagnostics.
p = Path("test/integration/app.test.ts")
s = p.read_text()
marker = '''  it("converts an upstream refusal to text with a refusal stop reason", async () => {\n'''
privacy_test = '''  it("does not log arbitrary malformed output_config values", async () => {\n    const privateEffort = "private-output-effort";\n    const privateFormat = "private-format-kind";\n    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);\n    try {\n      const app = createApp({}, async () => {\n        throw new Error("upstream must not be called");\n      });\n      const response = await app.inject({\n        method: "POST",\n        url: "/v1/messages",\n        headers: { "content-type": "application/json", "x-api-key": "caller-key" },\n        payload: {\n          model: "vendor/model-1",\n          max_tokens: 64,\n          output_config: {\n            effort: { secret: privateEffort },\n            format: { type: privateFormat },\n          },\n          messages: [{ role: "user", content: "hello" }],\n        },\n      });\n\n      expect(response.statusCode).toBe(400);\n      const logged = write.mock.calls.map(([chunk]) => String(chunk)).join("");\n      expect(logged).not.toContain(privateEffort);\n      expect(logged).not.toContain(privateFormat);\n      expect(logged).toContain('"outputEffortType":"object"');\n      expect(logged).toContain('"outputFormatType":"object"');\n    } finally {\n      write.mockRestore();\n    }\n  });\n\n'''
if marker not in s:
    raise SystemExit("privacy test insertion marker not found")
p.write_text(s.replace(marker, privacy_test + marker, 1))

# Unit regression: search frames are a prefix and answer indices are offset.
p = Path("test/unit/anthropic-stream-encode.test.ts")
s = p.read_text()
marker = '''  it("counts synthesized Web Search blocks against the aggregate stream output limit", () => {\n'''
order_test = '''  it("emits native Web Search blocks before answer content and offsets answer indices", () => {\n    const encoder = new AnthropicStreamEncoder({\n      webSearchExecutions: [\n        {\n          id: "call_search",\n          query: "latest news",\n          results: [{ title: "Result", url: "https://example.test", content: "body" }],\n        },\n      ],\n    });\n\n    const start = encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });\n    expect(start.map((frame) => frame.event)).toEqual([\n      "message_start",\n      "content_block_start",\n      "content_block_delta",\n      "content_block_stop",\n      "content_block_start",\n      "content_block_stop",\n    ]);\n    expect(start[1]?.data).toMatchObject({\n      index: 0,\n      content_block: { type: "server_tool_use", name: "web_search" },\n    });\n    expect(start[4]?.data).toMatchObject({\n      index: 1,\n      content_block: { type: "web_search_tool_result" },\n    });\n\n    expect(\n      encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } }),\n    ).toMatchObject([{ data: { index: 2, content_block: { type: "text" } } }]);\n    expect(encoder.encode({ type: "text_delta", index: 0, delta: "answer" })).toMatchObject([\n      { data: { index: 2, delta: { type: "text_delta", text: "answer" } } },\n    ]);\n  });\n\n'''
if marker not in s:
    raise SystemExit("stream order test insertion marker not found")
s = s.replace(marker, order_test + marker, 1)
old_limit = '''  it("counts synthesized Web Search blocks against the aggregate stream output limit", () => {\n    const encoder = new AnthropicStreamEncoder({\n      outputLimits: { perItemBytes: 1024, perStreamBytes: 600 },\n      webSearchExecutions: [{ id: "call_search", query: "q".repeat(200), results: [] }],\n    });\n    encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" });\n    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });\n    encoder.encode({ type: "text_delta", index: 0, delta: "a".repeat(100) });\n    encoder.encode({ type: "content_stop", index: 0 });\n\n    expect(() =>\n      encoder.encode({\n        type: "response_complete",\n        finishReason: "end_turn",\n        usage: { inputTokens: 1, outputTokens: 1, webSearchRequests: 1 },\n      }),\n    ).toThrowError(expect.objectContaining({ scope: "stream", code: "STREAM_OUTPUT_TOO_LARGE" }));\n  });\n'''
new_limit = '''  it("counts synthesized Web Search blocks against the aggregate stream output limit", () => {\n    const encoder = new AnthropicStreamEncoder({\n      outputLimits: { perItemBytes: 1024, perStreamBytes: 1400 },\n      webSearchExecutions: [{ id: "call_search", query: "q".repeat(200), results: [] }],\n    });\n    expect(() =>\n      encoder.encode({ type: "response_start", id: "resp_1", model: "model-a" }),\n    ).not.toThrow();\n    encoder.encode({ type: "content_start", index: 0, content: { type: "text", text: "" } });\n\n    expect(() =>\n      encoder.encode({ type: "text_delta", index: 0, delta: "a".repeat(500) }),\n    ).toThrowError(expect.objectContaining({ scope: "stream", code: "STREAM_OUTPUT_TOO_LARGE" }));\n  });\n'''
if old_limit not in s:
    raise SystemExit("stream output-limit test anchor not found")
p.write_text(s.replace(old_limit, new_limit, 1))
