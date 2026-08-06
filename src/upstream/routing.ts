export interface UpstreamFailure {
  status: number;
  code?: string;
}

export interface FallbackDecisionInput {
  failure: UpstreamFailure;
  hasUpstreamSemanticEvent: boolean;
  hasWrittenClientBytes: boolean;
}

const ROUTE_NOT_FOUND_CODES = new Set([
  "route_not_found",
  "endpoint_not_found",
  "unsupported_endpoint",
  "not_implemented",
]);

export function shouldFallbackToChat(input: FallbackDecisionInput): boolean {
  if (input.hasUpstreamSemanticEvent || input.hasWrittenClientBytes) {
    return false;
  }

  if (input.failure.status === 405 || input.failure.status === 501) {
    return true;
  }

  return (
    input.failure.status === 404 &&
    input.failure.code !== undefined &&
    ROUTE_NOT_FOUND_CODES.has(input.failure.code)
  );
}
