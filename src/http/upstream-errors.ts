import { UpstreamHttpError } from "../upstream/client.js";

export type ErrorProtocol = "anthropic" | "openai-responses";

export interface MappedHttpError {
  status: number;
  body: Record<string, unknown>;
}

export function mapUpstreamError(
  protocol: ErrorProtocol,
  error: unknown,
  requestId: string,
): MappedHttpError {
  const status = error instanceof UpstreamHttpError ? normalizeStatus(error.status) : 500;

  if (protocol === "anthropic") {
    return {
      status,
      body: {
        type: "error",
        error: {
          type: anthropicErrorType(status),
          message: publicMessage(status),
        },
        request_id: requestId,
      },
    };
  }

  return {
    status,
    body: {
      error: {
        message: publicMessage(status),
        type: openAiErrorType(status),
        code: openAiErrorCode(status),
      },
      request_id: requestId,
    },
  };
}

function normalizeStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 500;
}

function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function openAiErrorType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
}

function openAiErrorCode(status: number): string {
  if (status === 401) return "invalid_api_key";
  if (status === 429) return "rate_limit_exceeded";
  return status >= 500 ? "upstream_error" : "invalid_request";
}

function publicMessage(status: number): string {
  if (status === 401) return "The supplied API key is invalid";
  if (status === 403) return "The supplied API key cannot access this resource";
  if (status === 429) return "The upstream service rate limit was exceeded";
  if (status === 404) return "The requested upstream resource was not found";
  return status >= 500
    ? "The upstream service failed to process the request"
    : "The request failed";
}
