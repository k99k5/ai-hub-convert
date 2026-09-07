from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise RuntimeError(f"marker not found in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))


# Canonical IR: preserve Anthropic JSON-schema output constraints across protocol conversion.
replace_once(
    "src/core/ir.ts",
    'export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | null;\n\nexport interface CanonicalRequest {',
    'export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | null;\n\nexport interface JsonSchemaOutputFormat {\n  type: "json_schema";\n  schema: Record<string, unknown>;\n}\n\nexport interface CanonicalRequest {',
)
replace_once(
    "src/core/ir.ts",
    '  reasoningEffort?: ReasoningEffort;\n  messages: Message[];',
    '  reasoningEffort?: ReasoningEffort;\n  outputFormat?: JsonSchemaOutputFormat;\n  messages: Message[];',
)

# Anthropic decoder: accept the current output_config.format API shape.
replace_once(
    "src/protocols/anthropic/decode.ts",
    '  ImageContent,\n  Message,\n  ReasoningEffort,',
    '  ImageContent,\n  type JsonSchemaOutputFormat,\n  Message,\n  ReasoningEffort,',
)

p = Path("src/protocols/anthropic/decode.ts")
text = p.read_text()
start_marker = 'function parseOutputConfig(value: unknown): ReasoningEffort | undefined {'
end_marker = '\nfunction parseThinking(value: unknown): Record<string, unknown> | undefined {'
start = text.index(start_marker)
end = text.index(end_marker, start)
replacement = '''function parseOutputConfig(value: unknown): {
  reasoningEffort?: ReasoningEffort;
  outputFormat?: JsonSchemaOutputFormat;
} {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return invalidRequest();
  }
  for (const key of Object.keys(value)) {
    if (key !== "effort" && key !== "format") {
      return invalidRequest();
    }
  }

  const effort = value.effort;
  if (
    effort !== undefined &&
    effort !== null &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    return invalidRequest();
  }

  let outputFormat: JsonSchemaOutputFormat | undefined;
  const format = value.format;
  if (format !== undefined && format !== null) {
    if (
      !isRecord(format) ||
      format.type !== "json_schema" ||
      !isRecord(format.schema) ||
      !isJsonValue(format.schema) ||
      Object.keys(format).some((key) => key !== "type" && key !== "schema")
    ) {
      return invalidRequest();
    }
    outputFormat = { type: "json_schema", schema: format.schema };
  }

  return {
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
  };
}
'''
p.write_text(text[:start] + replacement + text[end:])

replace_once(
    "src/protocols/anthropic/decode.ts",
    '  const metadata = parseMetadata(input.metadata);\n  const reasoningEffort = parseOutputConfig(input.output_config);\n  const thinking = parseThinking(input.thinking);',
    '  const metadata = parseMetadata(input.metadata);\n  const outputConfig = parseOutputConfig(input.output_config);\n  const thinking = parseThinking(input.thinking);',
)
replace_once(
    "src/protocols/anthropic/decode.ts",
    '    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),\n    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),\n    messages:',
    '    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),\n    ...(outputConfig.reasoningEffort === undefined\n      ? {}\n      : { reasoningEffort: outputConfig.reasoningEffort }),\n    ...(outputConfig.outputFormat === undefined\n      ? {}\n      : { outputFormat: outputConfig.outputFormat }),\n    messages:',
)

# OpenAI Responses request: text.format JSON schema.
replace_once(
    "src/protocols/openai-responses/types.ts",
    '  reasoning?: Record<string, unknown> | null;\n  prompt_cache_key?: string | null;',
    '  reasoning?: Record<string, unknown> | null;\n  text?: {\n    format: {\n      type: "json_schema";\n      name: string;\n      schema: Record<string, unknown>;\n      strict: true;\n    };\n  };\n  prompt_cache_key?: string | null;',
)
replace_once(
    "src/protocols/openai-responses/encode.ts",
    '    ...(reasoning === null || (typeof reasoning === "object" && !Array.isArray(reasoning))\n      ? { reasoning: reasoning as Record<string, unknown> | null }\n      : {}),\n    ...(options.promptCache.kind === "prompt-cache-key"',
    '    ...(reasoning === null || (typeof reasoning === "object" && !Array.isArray(reasoning))\n      ? { reasoning: reasoning as Record<string, unknown> | null }\n      : {}),\n    ...(request.outputFormat === undefined\n      ? {}\n      : {\n          text: {\n            format: {\n              type: "json_schema" as const,\n              name: "response",\n              schema: request.outputFormat.schema,\n              strict: true as const,\n            },\n          },\n        }),\n    ...(options.promptCache.kind === "prompt-cache-key"',
)

# Chat fallback: response_format.json_schema.
replace_once(
    "src/protocols/openai-chat/types.ts",
    '  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;\n  stream: boolean;',
    '  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;\n  response_format?: {\n    type: "json_schema";\n    json_schema: {\n      name: string;\n      strict: true;\n      schema: Record<string, unknown>;\n    };\n  };\n  stream: boolean;',
)
replace_once(
    "src/protocols/openai-chat/encode.ts",
    '    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),\n    stream: request.stream,',
    '    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),\n    ...(request.outputFormat === undefined\n      ? {}\n      : {\n          response_format: {\n            type: "json_schema" as const,\n            json_schema: {\n              name: "response",\n              strict: true as const,\n              schema: request.outputFormat.schema,\n            },\n          },\n        }),\n    stream: request.stream,',
)

# Extend safe 400 diagnostics so a remaining decoder mismatch is immediately visible.
replace_once(
    "src/app.ts",
    '    toolsType: Array.isArray(tools) ? "array" : typeof tools,\n    ...(Array.isArray(tools) ? { toolCount: tools.length } : {}),\n    streamType:',
    '    toolsType: Array.isArray(tools) ? "array" : typeof tools,\n    ...(Array.isArray(tools) ? { toolCount: tools.length } : {}),\n    outputConfigType:\n      record.output_config === null\n        ? "null"\n        : Array.isArray(record.output_config)\n          ? "array"\n          : typeof record.output_config,\n    ...(typeof record.output_config === "object" &&\n    record.output_config !== null &&\n    !Array.isArray(record.output_config)\n      ? {\n          outputConfigKeys: Object.keys(record.output_config as Record<string, unknown>).sort(),\n          outputEffort: (record.output_config as Record<string, unknown>).effort,\n          outputFormatType:\n            typeof (record.output_config as Record<string, unknown>).format === "object" &&\n            (record.output_config as Record<string, unknown>).format !== null &&\n            !Array.isArray((record.output_config as Record<string, unknown>).format)\n              ? ((record.output_config as Record<string, unknown>).format as Record<string, unknown>).type\n              : typeof (record.output_config as Record<string, unknown>).format,\n        }\n      : {}),\n    streamType:',
)

# Regression tests.
Path("test/unit/anthropic-structured-output.test.ts").write_text('''import { describe, expect, it } from "vitest";
import { decodeAnthropicRequest } from "../../src/protocols/anthropic/decode.js";
import { encodeChatRequest } from "../../src/protocols/openai-chat/encode.js";
import { encodeResponsesRequest } from "../../src/protocols/openai-responses/encode.js";

const schema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["answer"],
  additionalProperties: false,
};

describe("Anthropic structured output conversion", () => {
  it("decodes output_config.format and maps it to Responses and Chat", () => {
    const decoded = decodeAnthropicRequest({
      model: "test-model",
      max_tokens: 65000,
      messages: [{ role: "user", content: "return json" }],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema },
      },
      stream: true,
    });

    expect(decoded.reasoningEffort).toBe("high");
    expect(decoded.outputFormat).toEqual({ type: "json_schema", schema });

    const responses = encodeResponsesRequest(decoded, {
      store: false,
      promptCache: { kind: "none" },
    });
    expect(responses.text).toEqual({
      format: {
        type: "json_schema",
        name: "response",
        schema,
        strict: true,
      },
    });

    const chat = encodeChatRequest(decoded);
    expect(chat.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema,
      },
    });
  });

  it("still rejects malformed output formats", () => {
    for (const format of [
      { type: "json_schema" },
      { type: "json_object", schema },
      { type: "json_schema", schema: [] },
      { type: "json_schema", schema, unknown: true },
    ]) {
      expect(() =>
        decodeAnthropicRequest({
          model: "test-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "x" }],
          output_config: { format },
        }),
      ).toThrowError();
    }
  });
});
''')

print("structured output patch applied")
