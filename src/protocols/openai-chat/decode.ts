import type { CanonicalResponse, Content, FinishReason, Usage } from "../../core/ir.js";
import { OpenAIAdapterError } from "./types.js";

function invalid(message: string): never {
  throw new OpenAIAdapterError("INVALID_OPENAI_CHAT_RESPONSE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`Invalid OpenAI Chat response: ${label} must be an object`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    invalid(`Invalid OpenAI Chat response: ${label} must be a string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`Invalid OpenAI Chat response: ${label} must be a non-negative number`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : number(value, label);
}

function decodeText(value: unknown): Content[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    invalid("Invalid OpenAI Chat response: message content must be a string, array, or null");
  }
  const content: Content[] = [];
  for (const rawPart of value) {
    const part = record(rawPart, "message content item");
    if (part.type === "text") {
      content.push({ type: "text", text: string(part.text, "message text") });
    } else if (part.type === "refusal") {
      content.push({ type: "refusal", refusal: string(part.refusal, "refusal text") });
    } else {
      invalid("Invalid OpenAI Chat response: unsupported message content item");
    }
  }
  return content;
}

function validateArguments(value: unknown, validate: boolean): string {
  const argumentsJson = string(value, "tool arguments");
  if (!validate) return argumentsJson;
  try {
    JSON.parse(argumentsJson);
  } catch {
    invalid("Invalid OpenAI Chat response: tool arguments must contain complete JSON");
  }
  return argumentsJson;
}

function decodeToolCalls(value: unknown, validateToolArguments: boolean): Content[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalid("Invalid OpenAI Chat response: tool_calls must be an array");
  }
  return value.map((rawCall) => {
    const call = record(rawCall, "tool call");
    if (call.type !== "function") {
      invalid("Invalid OpenAI Chat response: unsupported tool call type");
    }
    const fn = record(call.function, "tool call function");
    return {
      type: "function_call" as const,
      id: string(call.id, "tool call id"),
      name: string(fn.name, "tool function name"),
      arguments: validateArguments(fn.arguments, validateToolArguments),
    };
  });
}

function decodeUsage(value: unknown): Usage {
  const rawUsage = record(value, "usage");
  const promptDetails =
    rawUsage.prompt_tokens_details === undefined
      ? undefined
      : record(rawUsage.prompt_tokens_details, "prompt token details");
  const completionDetails =
    rawUsage.completion_tokens_details === undefined
      ? undefined
      : record(rawUsage.completion_tokens_details, "completion token details");
  const cacheRead =
    promptDetails === undefined
      ? undefined
      : optionalNumber(promptDetails.cached_tokens, "cached tokens");
  const cacheWrite =
    promptDetails === undefined
      ? undefined
      : optionalNumber(promptDetails.cache_write_tokens, "cache write tokens");
  const reasoning =
    completionDetails === undefined
      ? undefined
      : optionalNumber(completionDetails.reasoning_tokens, "reasoning tokens");
  return {
    inputTokens: number(rawUsage.prompt_tokens, "prompt tokens"),
    outputTokens: number(rawUsage.completion_tokens, "completion tokens"),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function decodeFinish(value: unknown, content: readonly Content[]): FinishReason {
  const reason = string(value, "finish_reason");
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "content_filter" || content.some((part) => part.type === "refusal")) {
    return "refusal";
  }
  if (reason === "stop") {
    return "end_turn";
  }
  return "incomplete";
}

export function decodeChatResponse(
  input: unknown,
  options: { preserveWireMetadata?: boolean; validateToolArguments?: boolean } = {},
): CanonicalResponse {
  const body = record(input, "body");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) {
    invalid("Invalid OpenAI Chat response: expected exactly one choice");
  }
  const choice = record(body.choices[0], "choice");
  const message = record(choice.message, "choice message");
  if (choice.index !== undefined && choice.index !== 0) {
    invalid("Chat 响应的候选索引必须为 0");
  }
  if (message.role !== undefined && message.role !== "assistant") {
    invalid("Chat 响应的消息角色必须为 assistant");
  }
  const content: Content[] = [];
  if (message.reasoning_content !== undefined && message.reasoning_content !== null) {
    content.push({
      type: "reasoning",
      text: string(message.reasoning_content, "reasoning_content"),
      source: "openai-chat",
    });
  }
  content.push(...decodeText(message.content));
  if (message.refusal !== undefined && message.refusal !== null) {
    content.push({ type: "refusal", refusal: string(message.refusal, "refusal") });
  }
  content.push(...decodeToolCalls(message.tool_calls, options.validateToolArguments !== false));
  return {
    id: string(body.id, "id"),
    model: string(body.model, "model"),
    content,
    finishReason: decodeFinish(choice.finish_reason, content),
    usage: decodeUsage(body.usage),
    ...(options.preserveWireMetadata
      ? {
          extensions: {
            source: "openai-chat" as const,
            response: {
              ...(body.created === undefined ? {} : { created: number(body.created, "created") }),
              finish_reason: choice.finish_reason,
            },
          },
        }
      : {}),
  };
}
