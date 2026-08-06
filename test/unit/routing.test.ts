import { describe, expect, it } from "vitest";
import { shouldFallbackToChat, type UpstreamFailure } from "../../src/upstream/routing.js";

describe("shouldFallbackToChat", () => {
  it.each([405, 501])("falls back for an unused Responses endpoint with status %s", (status) => {
    expect(
      shouldFallbackToChat({
        failure: { status, code: "unsupported_endpoint" },
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      }),
    ).toBe(true);
  });

  it("only accepts a 404 with a route-level code", () => {
    const routeFailure: UpstreamFailure = { status: 404, code: "route_not_found" };
    const modelFailure: UpstreamFailure = { status: 404, code: "model_not_found" };

    expect(
      shouldFallbackToChat({
        failure: routeFailure,
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      }),
    ).toBe(true);
    expect(
      shouldFallbackToChat({
        failure: modelFailure,
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      }),
    ).toBe(false);
  });

  it.each([401, 403, 429, 500, 502, 503, 504])("does not fallback for status %s", (status) => {
    expect(
      shouldFallbackToChat({
        failure: { status, code: "upstream_error" },
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      }),
    ).toBe(false);
  });

  it("does not fallback after an upstream semantic event or client write", () => {
    const failure: UpstreamFailure = { status: 405, code: "unsupported_endpoint" };

    expect(
      shouldFallbackToChat({
        failure,
        hasUpstreamSemanticEvent: true,
        hasWrittenClientBytes: false,
      }),
    ).toBe(false);
    expect(
      shouldFallbackToChat({
        failure,
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: true,
      }),
    ).toBe(false);
  });
});
