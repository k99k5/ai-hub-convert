import { describe, expect, it } from "vitest";
import { mapUpstreamError } from "../../src/http/upstream-errors.js";
import { UpstreamHttpError } from "../../src/upstream/client.js";

describe("mapUpstreamError", () => {
  it.each([
    ["anthropic", 401, "authentication_error"],
    ["anthropic", 403, "permission_error"],
    ["anthropic", 429, "rate_limit_error"],
    ["anthropic", 500, "api_error"],
    ["openai-responses", 401, "invalid_api_key"],
    ["openai-responses", 429, "rate_limit_exceeded"],
  ] as const)("maps %s status %s", (protocol, status, code) => {
    const result = mapUpstreamError(protocol, new UpstreamHttpError(status, {}), "req_test");

    expect(result.status).toBe(status);
    expect(result.body).toMatchObject(
      protocol === "anthropic"
        ? { type: "error", error: { type: code }, request_id: "req_test" }
        : { error: { code }, request_id: "req_test" },
    );
  });

  it("does not expose unknown exception messages", () => {
    const result = mapUpstreamError(
      "anthropic",
      new Error("secret https://private.example.test"),
      "req_test",
    );

    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("private.example.test");
  });
});
