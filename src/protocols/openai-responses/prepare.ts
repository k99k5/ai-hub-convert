import type { AppConfig } from "../../config.js";
import type { CanonicalRequest } from "../../core/ir.js";
import { GENERIC_PROMPT_CACHE_CAPABILITIES } from "../../policies/cache/capabilities.js";
import type { ResponsesReferenceCache } from "../../policies/responses-reference-cache.js";
import type { ResponsesHistoryCache } from "../../policies/responses-history-cache.js";
import { encodeResponsesChatRequest } from "./chat-bridge.js";
import { encodeResponsesRequest } from "./encode.js";
import { normalizeResponsesInput } from "./input-normalize.js";
import { decodeResponsesRequest } from "./request-decode.js";
import { OpenAIAdapterError } from "./types.js";
import {
  ConversationError,
  type ConversationStore,
  type ConversationTurn,
} from "../../policies/conversation-store.js";
import { conversationId, conversationItems } from "./conversation.js";

export interface PreparedResponsesRequest {
  request: CanonicalRequest;
  body: unknown;
  // Resolved input only: turn-specific instructions must not enter continuation history.
  input: unknown[];
  // A native upstream continuation on a cache miss has history we cannot reconstruct.
  historyComplete: boolean;
  conversation?: ConversationTurn;
}

export class ResponsesContinuationError extends Error {
  constructor(
    readonly code: "previous_response_not_found" | "request_too_large",
    message: string,
    readonly status: 400 | 413,
    readonly param: "previous_response_id" | "input",
  ) {
    super(message);
  }
}

export function prepareResponsesRequest(
  value: unknown,
  apiKey: string,
  config: AppConfig,
  referenceCache: ResponsesReferenceCache,
  historyCache?: ResponsesHistoryCache,
  conversations?: ConversationStore,
): PreparedResponsesRequest {
  let request = decodeResponsesRequest(value);
  let wire = value as Record<string, unknown>;
  const id = conversationId(wire.conversation);
  if (id !== undefined && !conversations) {
    throw new ConversationError(404, "conversation_not_found", "Conversation is unavailable");
  }
  const conversation = id === undefined ? undefined : conversations?.begin(apiKey, id);
  try {
    let input: unknown[] =
      typeof wire.input === "string"
        ? [{ role: "user", content: wire.input }]
        : Array.isArray(wire.input)
          ? wire.input
          : [];
    input = normalizeResponsesInput(input);
    if (Array.isArray(wire.input)) wire = { ...wire, input };
    let historyComplete = wire.previous_response_id == null;
    if (conversation) {
      const { conversation: _conversation, ...current } = wire;
      input = [...conversation.input, ...input];
      wire = { ...current, input };
      if (Buffer.byteLength(JSON.stringify(wire)) > config.server.bodyLimitBytes) {
        throw new ConversationError(
          413,
          "request_too_large",
          "Expanded conversation exceeds BODY_LIMIT_BYTES",
          "input",
        );
      }
      request = decodeResponsesRequest(wire);
    }
    if (historyCache && typeof wire.previous_response_id === "string") {
      const history = historyCache.resolve(apiKey, request.model, wire.previous_response_id);
      if (history === undefined) {
        if (config.upstream.protocol === "chat") {
          throw new ResponsesContinuationError(
            "previous_response_not_found",
            "上一轮响应已过期或不可用，请发送完整历史内容",
            400,
            "previous_response_id",
          );
        }
        // Preserve native Responses continuation, including externally stored IDs.
        // Never cache its partial input as if it contained the whole conversation.
      } else {
        const { previous_response_id, ...current } = wire;
        input = [...history, ...input];
        wire = { ...current, input };
        if (Buffer.byteLength(JSON.stringify(wire)) > config.server.bodyLimitBytes) {
          throw new ResponsesContinuationError(
            "request_too_large",
            "展开历史后的请求超过请求体大小限制",
            413,
            "input",
          );
        }
        request = decodeResponsesRequest(wire);
        historyComplete = true;
      }
    }
    if (request.messages.some((message) => message.itemReference !== undefined)) {
      let expandedBytes = Buffer.byteLength(JSON.stringify(wire));
      input = input.map((raw) => {
        // The decoder above has already validated every input item.
        const item = raw as Record<string, unknown>;
        if (item.type !== "item_reference") return item;
        const resolved = referenceCache.resolve(apiKey, request.model, item.id as string);
        if (resolved === undefined) {
          throw new OpenAIAdapterError(
            "REFERENCE_CACHE_MISS",
            "引用缓存已过期或不可用，请新建会话或发送完整历史内容",
          );
        }
        expandedBytes +=
          Buffer.byteLength(JSON.stringify(resolved)) - Buffer.byteLength(JSON.stringify(item));
        if (expandedBytes > config.server.bodyLimitBytes) {
          throw new OpenAIAdapterError(
            "INVALID_OPENAI_RESPONSES_REQUEST",
            "展开引用后的请求超过请求体大小限制",
          );
        }
        return resolved;
      });
      request = decodeResponsesRequest({ ...wire, input });
    }
    conversation?.stage(conversationItems(input.slice(conversation.input.length)));
    let body =
      config.upstream.protocol === "chat"
        ? encodeResponsesChatRequest(request)
        : encodeResponsesRequest(request, {
            store: false,
            replaySourceExtensions: true,
            promptCache: GENERIC_PROMPT_CACHE_CAPABILITIES.responses,
          });
    if (conversation) body = { ...body, store: false };
    return { request, body, input, historyComplete, ...(conversation ? { conversation } : {}) };
  } catch (error) {
    conversation?.release();
    throw error;
  }
}
