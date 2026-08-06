import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  extractAnthropicApiKey,
  extractResponsesApiKey,
} from "../../src/http/auth.js";

describe("extractAnthropicApiKey", () => {
  it("accepts x-api-key", () => {
    expect(extractAnthropicApiKey({ "x-api-key": "secret" })).toBe("secret");
  });

  it("accepts a bearer token for Claude Code", () => {
    expect(extractAnthropicApiKey({ authorization: "Bearer secret" })).toBe("secret");
  });

  it("rejects conflicting credentials without exposing either value", () => {
    let error: unknown;
    try {
      extractAnthropicApiKey({
        "x-api-key": "first-secret",
        authorization: "Bearer second-secret",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(String(error)).not.toContain("first-secret");
    expect(String(error)).not.toContain("second-secret");
  });
});

describe("extractResponsesApiKey", () => {
  it("requires a bearer token", () => {
    expect(extractResponsesApiKey({ authorization: "Bearer secret" })).toBe("secret");
    expect(() => extractResponsesApiKey({ "x-api-key": "secret" })).toThrow(AuthenticationError);
  });

  it("rejects malformed authorization schemes", () => {
    expect(() => extractResponsesApiKey({ authorization: "Basic secret" })).toThrow(
      AuthenticationError,
    );
  });
});
