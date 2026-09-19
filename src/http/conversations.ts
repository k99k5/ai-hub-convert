import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import { ConversationError, type ConversationStore } from "../policies/conversation-store.js";
import { conversationItems } from "../protocols/openai-responses/conversation.js";
import { decodeResponsesRequest } from "../protocols/openai-responses/request-decode.js";
import { OpenAIAdapterError } from "../protocols/openai-responses/types.js";
import { AuthenticationError, extractResponsesApiKey } from "./auth.js";
import { mapUpstreamError } from "./upstream-errors.js";

type Wire = Record<string, unknown>;
const bodySchema = Type.Object({}, { additionalProperties: true });
function body(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversationError(400, "invalid_request", "Expected a JSON object", "body");
  }
  return value as Wire;
}
function metadata(value: unknown): Record<string, string> {
  const fields = value === null ? {} : body(value);
  if (
    Object.keys(fields).length > 16 ||
    Object.entries(fields).some(
      ([key, field]) => key.length > 64 || typeof field !== "string" || field.length > 512,
    )
  ) {
    throw new ConversationError(
      400,
      "invalid_request",
      "metadata must contain at most 16 string values with keys up to 64 and values up to 512 characters",
      "metadata",
    );
  }
  return fields as Record<string, string>;
}
function items(value: unknown) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ConversationError(
      400,
      "invalid_request",
      "items must be an array of at most 20 items",
      "items",
    );
  }
  decodeResponsesRequest({ model: "conversation", input: value });
  return conversationItems(value);
}
function page(data: Wire[], hasMore = false) {
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: hasMore,
  };
}
function include(query: Wire): void {
  const value = query.include ?? query["include[]"];
  if (value === undefined) return;
  const values = Array.isArray(value) ? value : [value];
  if (
    !values.every((field) =>
      [
        "reasoning.encrypted_content",
        "web_search_call.action.sources",
        "message.input_image.image_url",
      ].includes(field as string),
    )
  ) {
    throw new ConversationError(
      400,
      "invalid_request",
      "Unsupported conversation item include",
      "include",
    );
  }
}

export function registerConversationRoutes(api: FastifyInstance, store: ConversationStore): void {
  const handle =
    (handler: (request: FastifyRequest, apiKey: string, params: Wire, query: Wire) => unknown) =>
    async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      try {
        const apiKey = extractResponsesApiKey(request.headers);
        return handler(request, apiKey, request.params as Wire, request.query as Wire);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply.code(401).send({
            error: {
              type: "authentication_error",
              code: "invalid_api_key",
              message: error.message,
            },
            request_id: request.id,
          });
        }
        if (error instanceof OpenAIAdapterError) {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              code: "invalid_request",
              message: error.message,
              param: "items",
            },
            request_id: request.id,
          });
        }
        if (error instanceof ConversationError) {
          const mapped = mapUpstreamError("openai-responses", error, request.id);
          return reply.code(mapped.status).send(mapped.body);
        }
        throw error;
      }
    };
  api.post(
    "/v1/conversations",
    handle((request, key) => {
      const value = request.body === undefined ? {} : body(request.body);
      return store.create(
        key,
        value.metadata === undefined ? {} : metadata(value.metadata),
        value.items == null ? [] : items(value.items),
      );
    }),
  );
  api.get(
    "/v1/conversations/:conversation_id",
    { exposeHeadRoute: false },
    handle((_request, key, params) => store.retrieve(key, params.conversation_id as string)),
  );
  api.post(
    "/v1/conversations/:conversation_id",
    { schema: { body: bodySchema } },
    handle((request, key, params) => {
      const value = body(request.body);
      return store.update(
        key,
        params.conversation_id as string,
        value.metadata === undefined ? undefined : metadata(value.metadata),
      );
    }),
  );
  api.delete(
    "/v1/conversations/:conversation_id",
    handle((_request, key, params) => store.delete(key, params.conversation_id as string)),
  );
  api.post(
    "/v1/conversations/:conversation_id/items",
    { schema: { body: bodySchema } },
    handle((request, key, params, query) => {
      include(query);
      const added = items(body(request.body).items);
      store.append(key, params.conversation_id as string, added);
      return page(added);
    }),
  );
  api.get(
    "/v1/conversations/:conversation_id/items",
    { exposeHeadRoute: false },
    handle((_request, key, params, query) => {
      include(query);
      const limit =
        query.limit === undefined
          ? 20
          : typeof query.limit === "string" && /^\d+$/.test(query.limit)
            ? Number(query.limit)
            : Number.NaN;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (query.order !== undefined && query.order !== "asc" && query.order !== "desc") ||
        (query.after !== undefined && typeof query.after !== "string")
      ) {
        throw new ConversationError(
          400,
          "invalid_request",
          "Invalid conversation item pagination",
          "query",
        );
      }
      const all = store.items(key, params.conversation_id as string);
      if (query.order !== "asc") all.reverse();
      let start = 0;
      if (query.after !== undefined) {
        start = all.findIndex((item) => item.id === query.after) + 1;
        if (start === 0)
          throw new ConversationError(
            400,
            "invalid_request",
            "Pagination cursor was not found in this conversation",
            "after",
          );
      }
      return page(all.slice(start, start + limit), start + limit < all.length);
    }),
  );
  api.get(
    "/v1/conversations/:conversation_id/items/:item_id",
    { exposeHeadRoute: false },
    handle((_request, key, params, query) => {
      include(query);
      const item = store
        .items(key, params.conversation_id as string)
        .find((value) => value.id === params.item_id);
      if (!item)
        throw new ConversationError(
          404,
          "item_not_found",
          "Conversation item was not found",
          "item_id",
        );
      return item;
    }),
  );
  api.delete(
    "/v1/conversations/:conversation_id/items/:item_id",
    handle((_request, key, params) =>
      store.deleteItem(key, params.conversation_id as string, params.item_id as string),
    ),
  );
}
