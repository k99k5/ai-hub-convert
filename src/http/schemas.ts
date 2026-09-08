import { Type } from "@sinclair/typebox";

const JsonObject = Type.Object({}, { additionalProperties: true });
const System = Type.Union([
  Type.String(),
  Type.Array(
    Type.Object(
      {
        type: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  ),
]);

export const AnthropicMessagesBodySchema = Type.Object(
  {
    model: Type.String(),
    max_tokens: Type.Number(),
    messages: Type.Array(JsonObject),
    system: Type.Optional(System),
    stream: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export const AnthropicTokenCountBodySchema = Type.Object(
  {
    model: Type.String(),
    messages: Type.Array(JsonObject),
    system: Type.Optional(System),
  },
  { additionalProperties: true },
);

export const OpenAIResponsesBodySchema = Type.Object(
  {
    model: Type.String(),
    stream: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);

export const OpenAIChatBodySchema = Type.Object(
  {
    model: Type.String(),
    messages: Type.Array(JsonObject),
    stream: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true },
);
