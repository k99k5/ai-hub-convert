import { randomUUID } from "node:crypto";
import { ConversationError, type ConversationItem } from "../../policies/conversation-store.js";
import { normalizeResponsesInput } from "./input-normalize.js";
import type { ResponsesSseFrame } from "./stream-encode.js";

export function conversationId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const id =
    typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).id
      : value;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    throw new ConversationError(
      400,
      "invalid_request",
      "conversation must be a non-empty ID or an object containing id",
    );
  }
  return id;
}

// Inputs have already passed Responses decoding. Completed outputs have passed
// the response encoder; preserve their annotations and opaque reasoning data.
export function conversationItems(input: readonly unknown[], output = false): ConversationItem[] {
  const items = output ? structuredClone(input) : normalizeResponsesInput(input);
  return items.map((raw) => {
    const item = raw as Record<string, unknown>;
    if (item.type === "item_reference") {
      throw new ConversationError(
        400,
        "invalid_request",
        "Conversation items require full content, not unresolved item references",
        "items",
      );
    }
    const type = item.type ?? "message";
    const id = item.id ?? `${type === "message" ? "msg" : "item"}_${randomUUID()}`;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 256 ||
      (item.status !== undefined && typeof item.status !== "string")
    ) {
      throw new ConversationError(
        400,
        "invalid_request",
        "Invalid conversation item id or status",
        "items",
      );
    }
    return {
      ...item,
      id,
      type,
      status: item.status ?? "completed",
      ...(type === "message" && typeof item.content === "string"
        ? {
            content: [
              {
                type: item.role === "assistant" ? "output_text" : "input_text",
                text: item.content,
                ...(item.role === "assistant" ? { annotations: [] } : {}),
              },
            ],
          }
        : {}),
    };
  });
}

export function withConversationFrame(
  frame: ResponsesSseFrame | string,
  id?: string,
): ResponsesSseFrame | string {
  if (!id || typeof frame === "string" || !frame.data.response) return frame;
  return {
    ...frame,
    data: {
      ...frame.data,
      response: { ...(frame.data.response as Record<string, unknown>), conversation: { id } },
    },
  };
}
