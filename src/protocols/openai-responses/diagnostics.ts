import type { OpenAIAdapterError } from "./types.js";
import { UpstreamHttpError } from "../../upstream/client.js";

const knownTags = new Set([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "item_reference",
  "web_search_call",
  "file_search_call",
  "computer_call",
  "computer_call_output",
  "input_text",
  "output_text",
  "summary_text",
  "reasoning_text",
  "text",
  "input_image",
  "input_file",
  "input_audio",
  "refusal",
  "tool_use",
  "tool_result",
]);
const knownFields = [
  "type",
  "role",
  "id",
  "call_id",
  "name",
  "arguments",
  "content",
  "output",
  "summary",
  "text",
  "refusal",
  "encrypted_content",
  "image_url",
  "file_id",
  "detail",
  "status",
  "input",
  "model",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "previous_response_id",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kind(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

// 只输出固定字段的类型和长度；客户端自定义键名和未知枚举值也可能包含正文。
function shape(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { kind: "string", length: value.length };
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (!isRecord(value)) return { kind: kind(value) };
  const fields: Record<string, unknown> = {};
  for (const field of knownFields) {
    if (!Object.hasOwn(value, field)) continue;
    const child = value[field];
    fields[field] =
      (field === "type" || field === "role") && typeof child === "string" && knownTags.has(child)
        ? child
        : {
            kind: kind(child),
            ...(typeof child === "string" || Array.isArray(child) ? { length: child.length } : {}),
          };
  }
  return {
    kind: "object",
    fields,
    unknown_field_count: Object.keys(value).length - Object.keys(fields).length,
  };
}

export function responsesInputDiagnostic(body: unknown, error: OpenAIAdapterError) {
  const input = isRecord(body) ? body.input : undefined;
  const path = error.inputPath;
  let rejected = body;
  // 路径由解析器中的固定字段和数组下标构造，不接受客户端提供的路径。
  if (path !== undefined) {
    for (const match of path.matchAll(/([a-z_]+)|\[(\d+)\]/g)) {
      if (match[1] !== undefined) {
        rejected = isRecord(rejected) ? rejected[match[1]] : undefined;
      } else if (match[2] !== undefined) {
        rejected = Array.isArray(rejected) ? rejected[Number(match[2])] : undefined;
      }
    }
  }
  return {
    stage: "request_decode",
    code: error.code,
    reason: error.message,
    diagnostic_path: path ?? "request",
    input_kind: kind(input),
    ...(Array.isArray(input) ? { input_count: input.length } : {}),
    rejected_shape: shape(rejected),
  };
}

export function responsesUpstreamDiagnostic(error: unknown) {
  const knownCodes = new Set([
    "item_not_found",
    "tool_call_not_found",
    "invalid_request_error",
    "invalid_request",
    "invalid_value",
    "unsupported_value",
    "unsupported_parameter",
    "model_not_found",
    "context_length_exceeded",
  ]);
  if (error instanceof UpstreamHttpError) {
    return {
      stage: "upstream_http",
      upstream_status: error.status,
      upstream_code:
        error.code === undefined
          ? "absent"
          : knownCodes.has(error.code)
            ? error.code
            : "unrecognized",
      reference_hint: error.referenceHint ?? "unknown",
      has_upstream_semantic_event: error.hasUpstreamSemanticEvent,
    };
  }
  return { stage: "gateway_processing", reference_hint: "unknown" };
}
