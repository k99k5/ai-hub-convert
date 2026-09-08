import type { ChatCompletion } from "openai/resources/chat/completions.js";
import type { CompletionUsage } from "openai/resources/completions.js";
import type { CanonicalResponse, FinishReason, ProviderExtensions, Usage } from "../../core/ir.js";
import { OpenAIAdapterError } from "./types.js";

export function chatResponseMetadata(extensions?: ProviderExtensions): Record<string, unknown> {
  return extensions?.source === "openai-chat" ? (extensions.response ?? {}) : {};
}

export function encodeChatFinishReason(
  reason: FinishReason,
  wireReason?: unknown,
): ChatCompletion.Choice["finish_reason"] {
  if (
    wireReason === "stop" ||
    wireReason === "length" ||
    wireReason === "tool_calls" ||
    wireReason === "content_filter" ||
    wireReason === "function_call"
  )
    return wireReason;
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "incomplete":
      return "length";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
      return "stop";
  }
}

export function encodeChatUsage(usage: Usage): CompletionUsage {
  const promptDetails = {
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cached_tokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cache_write_tokens: usage.cacheWriteInputTokens }),
  };
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(Object.keys(promptDetails).length === 0 ? {} : { prompt_tokens_details: promptDetails }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : {
          completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
        }),
  };
}

export function chatCreated(metadata: Record<string, unknown>): number {
  if (metadata.created === undefined) return Math.floor(Date.now() / 1000);
  if (
    typeof metadata.created !== "number" ||
    !Number.isSafeInteger(metadata.created) ||
    metadata.created < 0
  ) {
    throw new OpenAIAdapterError(
      "INVALID_OPENAI_CHAT_RESPONSE",
      "Chat 响应的 created 必须为非负整数",
    );
  }
  return metadata.created;
}

export function encodeChatResponse(response: CanonicalResponse): ChatCompletion {
  const text: string[] = [];
  const refusals: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: NonNullable<ChatCompletion.Choice["message"]["tool_calls"]> = [];
  for (const content of response.content) {
    switch (content.type) {
      case "text":
        text.push(content.text);
        break;
      case "refusal":
        refusals.push(content.refusal);
        break;
      case "reasoning":
        reasoning.push(content.text);
        break;
      case "function_call":
        toolCalls.push({
          id: content.id,
          type: "function",
          function: {
            name: content.name,
            arguments: content.arguments,
          },
        });
        break;
      default:
        throw new OpenAIAdapterError(
          "INVALID_OPENAI_CHAT_RESPONSE",
          `Chat 响应不支持内容类型：${content.type}`,
        );
    }
  }
  const metadata = chatResponseMetadata(response.extensions);
  return {
    id: response.id,
    object: "chat.completion",
    created: chatCreated(metadata),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text.length === 0 ? null : text.join(""),
          refusal: refusals.length === 0 ? null : refusals.join(""),
          ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning.join("") }),
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        },
        finish_reason: encodeChatFinishReason(response.finishReason, metadata.finish_reason),
        logprobs: null,
      },
    ],
    usage: encodeChatUsage(response.usage),
  };
}
