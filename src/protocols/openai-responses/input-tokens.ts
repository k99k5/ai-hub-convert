import type { CanonicalRequest } from "../../core/ir.js";
import { encodeResponsesRequest } from "./encode.js";

export interface ResponsesInputTokensRequest {
  model: string;
  input: ReturnType<typeof encodeResponsesRequest>["input"];
  tools?: ReturnType<typeof encodeResponsesRequest>["tools"];
  tool_choice?: ReturnType<typeof encodeResponsesRequest>["tool_choice"];
  parallel_tool_calls?: boolean;
  reasoning?: ReturnType<typeof encodeResponsesRequest>["reasoning"];
}

export function encodeResponsesInputTokensRequest(
  request: CanonicalRequest,
): ResponsesInputTokensRequest {
  const encoded = encodeResponsesRequest(request, {
    store: false,
    promptCache: { kind: "none" },
  });
  return {
    model: encoded.model,
    input: encoded.input,
    ...(encoded.tools === undefined ? {} : { tools: encoded.tools }),
    ...(encoded.tool_choice === undefined ? {} : { tool_choice: encoded.tool_choice }),
    ...(encoded.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: encoded.parallel_tool_calls }),
    ...(encoded.reasoning === undefined ? {} : { reasoning: encoded.reasoning }),
  };
}

export function decodeResponsesInputTokensResponse(value: unknown): number {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).object !== "response.input_tokens"
  ) {
    throw new Error("Invalid Responses input token count response");
  }
  const inputTokens = (value as Record<string, unknown>).input_tokens;
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error("Invalid Responses input token count response");
  }
  return inputTokens;
}
