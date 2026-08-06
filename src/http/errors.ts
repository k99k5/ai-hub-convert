import type { FastifyReply } from "fastify";

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "permission_error"
      | "not_found_error"
      | "request_too_large"
      | "rate_limit_error"
      | "api_error"
      | "overloaded_error";
    message: string;
  };
  request_id: string;
}

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: "invalid_request_error";
    code: "invalid_request" | "request_too_large";
  };
  request_id: string;
}

export function sendOpenAIRequestError(
  reply: FastifyReply,
  statusCode: 400 | 413,
  code: OpenAIErrorBody["error"]["code"],
  message: string,
): FastifyReply {
  const body: OpenAIErrorBody = {
    error: { message, type: "invalid_request_error", code },
    request_id: reply.request.id,
  };
  return reply.code(statusCode).send(body);
}

export function sendAnthropicError(
  reply: FastifyReply,
  statusCode: number,
  type: AnthropicErrorBody["error"]["type"],
  message: string,
): FastifyReply {
  const body: AnthropicErrorBody = {
    type: "error",
    error: { type, message },
    request_id: reply.request.id,
  };

  return reply.code(statusCode).send(body);
}
