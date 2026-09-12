import { randomUUID } from "node:crypto";
import type { CanonicalEvent } from "../../core/events.js";
import type { CanonicalRequest, CanonicalResponse, Content, Message } from "../../core/ir.js";
import { encodeChatRequest } from "../openai-chat/encode.js";
import type { ChatRequest } from "../openai-chat/types.js";
import { encodeResponsesResponse } from "./response-encode.js";
import { OpenAIAdapterError, type ResponsesTextConfig } from "./types.js";

function invalid(message: string): never {
  throw new OpenAIAdapterError("INVALID_OPENAI_RESPONSES_REQUEST", message);
}

// Responses splits an assistant turn into reasoning, messages and individual calls.
// Chat needs those calls in one assistant message before the tool-result messages.
function chatHistory(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "reasoning" && part.opaque && part.text.length === 0) {
        invalid("Chat 上游无法使用只有加密内容的推理历史，请发送明文历史或新建会话");
      }
      if (part.type === "image" && part.detail === "original") {
        invalid("Chat 上游不支持图片 detail:original，请使用 auto、low 或 high");
      }
    }
    const previous = result.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      previous.content.push(...message.content);
    } else result.push({ ...message, content: [...message.content] });
  }
  return result;
}

export function encodeResponsesChatRequest(request: CanonicalRequest): ChatRequest {
  const extensions = request.extensions?.request ?? {};
  if (extensions.previous_response_id !== undefined && extensions.previous_response_id !== null) {
    invalid("Chat 上游不支持 previous_response_id，请发送完整历史或使用本地 item_reference");
  }
  const body = encodeChatRequest({ ...request, messages: chatHistory(request.messages) });
  const reasoning = extensions.reasoning as Record<string, unknown> | null | undefined;
  const effort = reasoning?.effort;
  if (effort !== undefined) {
    if (
      effort !== null &&
      (typeof effort !== "string" ||
        !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort))
    )
      invalid("Chat 上游不支持该 reasoning.effort");
    body.reasoning_effort = effort as Exclude<ChatRequest["reasoning_effort"], undefined>;
  }
  const text = extensions.text as ResponsesTextConfig | undefined;
  if (text?.format) {
    if (text.format.type === "json_schema") {
      const { type, ...schema } = text.format;
      body.response_format = { type, json_schema: schema };
    } else body.response_format = { type: text.format.type };
  }
  if (text?.verbosity !== undefined) body.verbosity = text.verbosity;
  if (request.metadata !== undefined) body.metadata = request.metadata;
  if (typeof extensions.store === "boolean" || extensions.store === null)
    body.store = extensions.store;
  else body.store = false;
  return body;
}

function itemType(content: Content): "message" | "reasoning" | "function_call" {
  if (content.type === "reasoning" || content.type === "function_call") return content.type;
  return "message";
}

function itemId(content: Content): string {
  const prefix =
    content.type === "reasoning" ? "rs" : content.type === "function_call" ? "fc" : "msg";
  return `${prefix}_${randomUUID()}`;
}

export function encodeChatAsResponses(response: CanonicalResponse): Record<string, unknown> {
  const incomplete =
    response.finishReason === "max_tokens" || response.finishReason === "incomplete";
  const status = incomplete ? "incomplete" : "completed";
  return encodeResponsesResponse({
    ...response,
    id: `resp_${randomUUID()}`,
    extensions: {
      source: "openai-responses",
      response: {
        object: "response",
        created_at: response.extensions?.response?.created ?? Math.floor(Date.now() / 1000),
        status,
        incomplete_details: incomplete
          ? {
              reason:
                response.finishReason === "max_tokens" ? "max_output_tokens" : "content_filter",
            }
          : null,
        output_layout: response.content.map((part) => ({
          type: itemType(part),
          id: itemId(part),
          contentCount: 1,
          status,
        })),
        usage: {
          total_tokens: response.usage.inputTokens + response.usage.outputTokens,
          input_tokens_details_present:
            response.usage.cacheReadInputTokens !== undefined ||
            response.usage.cacheWriteInputTokens !== undefined,
          output_tokens_details_present: response.usage.reasoningTokens !== undefined,
        },
      },
    },
  });
}

export function chatEventForResponses(event: CanonicalEvent): CanonicalEvent {
  if (event.type === "response_start") return { ...event, id: `resp_${randomUUID()}` };
  if (event.type === "content_start") return { ...event, itemId: itemId(event.content) };
  return event;
}
