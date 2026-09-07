import type { CanonicalResponse, Citation, FinishReason, ReasoningContent } from "../../core/ir.js";
import type {
  AnthropicImageBlock,
  AnthropicMessageResponse,
  AnthropicResponseContentBlock,
  AnthropicResponseThinkingBlock,
  AnthropicStopReason,
  AnthropicUrlCitation,
  AnthropicUsage,
} from "./types.js";

export type AnthropicEncodeErrorCode =
  | "invalid_response"
  | "invalid_tool_arguments"
  | "unsupported_content";

export class AnthropicEncodeError extends Error {
  readonly code: AnthropicEncodeErrorCode;

  constructor(code: AnthropicEncodeErrorCode, message: string) {
    super(message);
    this.name = "AnthropicEncodeError";
    this.code = code;
  }
}

export interface AnthropicEncodeOptions {
  finalizeThinking?: (reasoning: ReasoningContent) => {
    text: string;
    signature?: string;
    synthetic?: boolean;
  };
}

const invalidResponse = (): never => {
  throw new AnthropicEncodeError("invalid_response", "Invalid canonical response");
};

function parseArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AnthropicEncodeError(
      "invalid_tool_arguments",
      "Function arguments are not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnthropicEncodeError(
      "invalid_tool_arguments",
      "Function arguments must contain a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function encodeCitation(citation: Citation, text: string): AnthropicUrlCitation {
  const startIndex = citation.startIndex ?? 0;
  const endIndex = citation.endIndex ?? text.length;
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex > text.length
  ) {
    return invalidResponse();
  }
  return {
    type: "web_search_result_location",
    url: citation.url,
    title: citation.title ?? null,
    cited_text: text.slice(startIndex, endIndex),
    encrypted_index: "",
  };
}

function encodeThinking(
  reasoning: ReasoningContent,
  options: AnthropicEncodeOptions,
): AnthropicResponseThinkingBlock {
  const finalized = options.finalizeThinking?.(reasoning);
  if (
    finalized !== undefined &&
    (typeof finalized.text !== "string" ||
      (finalized.signature !== undefined && typeof finalized.signature !== "string"))
  ) {
    return invalidResponse();
  }
  const text = finalized?.text ?? reasoning.text;
  const signature = finalized?.signature ?? reasoning.signature;
  return {
    type: "thinking",
    thinking: text,
    ...(signature ? { signature } : {}),
  };
}

function encodeImage(source: CanonicalResponse["content"][number]): AnthropicImageBlock {
  if (source.type !== "image") {
    return invalidResponse();
  }
  if (source.source.type === "url") {
    return {
      type: "image",
      source: { type: "url", url: source.source.url },
    };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: source.source.mediaType,
      data: source.source.data,
    },
  };
}

function encodeContent(
  content: CanonicalResponse["content"][number],
  options: AnthropicEncodeOptions,
): AnthropicResponseContentBlock {
  switch (content.type) {
    case "text":
      return {
        type: "text",
        text: content.text,
        ...(content.citations && content.citations.length > 0
          ? {
              citations: content.citations.map((citation) =>
                encodeCitation(citation, content.text),
              ),
            }
          : {}),
      };
    case "image":
      return encodeImage(content);
    case "reasoning":
      return encodeThinking(content, options);
    case "function_call":
      return {
        type: "tool_use",
        id: content.id,
        name: content.name,
        input: parseArguments(content.arguments),
      };
    case "search_result":
      return {
        type: "search_result",
        title: content.title,
        source: content.source,
        content: [{ type: "text", text: content.content }],
        citations: { enabled: content.citationsEnabled },
      };
    case "function_result":
      throw new AnthropicEncodeError(
        "unsupported_content",
        "Function results are not valid assistant response content",
      );
    case "refusal":
      return { type: "text", text: content.refusal };
  }
}

function encodeStopReason(finishReason: FinishReason): AnthropicStopReason {
  switch (finishReason) {
    case "end_turn":
    case "max_tokens":
    case "tool_use":
    case "stop_sequence":
    case "refusal":
      return finishReason;
    case "incomplete":
      return "pause_turn";
  }
}

function encodeUsage(response: CanonicalResponse): AnthropicUsage {
  const cacheRead = response.usage.cacheReadInputTokens;
  const cacheWrite = response.usage.cacheWriteInputTokens;
  const webSearchRequests = response.usage.webSearchRequests;
  if (
    (cacheRead !== undefined && (!Number.isFinite(cacheRead) || cacheRead < 0)) ||
    (cacheWrite !== undefined && (!Number.isFinite(cacheWrite) || cacheWrite < 0)) ||
    (webSearchRequests !== undefined &&
      (!Number.isSafeInteger(webSearchRequests) || webSearchRequests < 0)) ||
    !Number.isFinite(response.usage.inputTokens) ||
    !Number.isFinite(response.usage.outputTokens) ||
    response.usage.outputTokens < 0
  ) {
    return invalidResponse();
  }
  return {
    input_tokens: Math.max(0, response.usage.inputTokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    output_tokens: response.usage.outputTokens,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
    ...(webSearchRequests !== undefined
      ? { server_tool_use: { web_search_requests: webSearchRequests } }
      : {}),
  };
}

export function encodeAnthropicResponse(
  response: CanonicalResponse,
  options: AnthropicEncodeOptions = {},
): AnthropicMessageResponse {
  if (!response.id || !response.model) {
    return invalidResponse();
  }
  const stopReason = encodeStopReason(response.finishReason);
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: response.content.map((content) => encodeContent(content, options)),
    stop_reason: stopReason,
    stop_sequence:
      stopReason === "stop_sequence" && response.stopSequence !== undefined
        ? response.stopSequence
        : null,
    usage: encodeUsage(response),
  };
}
