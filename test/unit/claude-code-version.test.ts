import { describe, expect, it } from "vitest";
import {
  assertClaudeCodeVersionAllowed,
  extractClaudeCodeVersion,
  parseVersionRange,
} from "../../src/profiles/claude-code/version.js";

describe("extractClaudeCodeVersion", () => {
  it("prefers cc_version in the first system attribution block", () => {
    const result = extractClaudeCodeVersion({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.220.04c; cc_entrypoint=cli;",
        },
      ],
      userAgent: "claude-cli/2.1.219 (external, cli)",
    });

    expect(result).toEqual({
      source: "system",
      version: "2.1.220",
      userAgentMismatch: true,
    });
  });

  it("falls back to the claude-cli user agent", () => {
    expect(
      extractClaudeCodeVersion({
        system: "You are helpful",
        userAgent: "claude-cli/2.3.4 (external, cli)",
      }),
    ).toEqual({ source: "user-agent", version: "2.3.4", userAgentMismatch: false });
  });

  it("treats missing or malformed versions as a normal SDK request", () => {
    expect(
      extractClaudeCodeVersion({
        system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=latest;" }],
        userAgent: "anthropic-typescript/0.115.0",
      }),
    ).toEqual({ source: "none", userAgentMismatch: false });

    expect(
      extractClaudeCodeVersion({
        userAgent: "claude-cli/02.1.220 (external, cli)",
      }),
    ).toEqual({ source: "none", userAgentMismatch: false });

    expect(
      extractClaudeCodeVersion({
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=02.1.220.04c; cc_entrypoint=cli;",
          },
        ],
      }),
    ).toEqual({ source: "none", userAgentMismatch: false });
  });
});

describe("Claude Code version range", () => {
  it("uses an inclusive minimum and maximum", () => {
    const range = parseVersionRange({ min: "2.1.63", max: "2.5.0" });

    expect(() => assertClaudeCodeVersionAllowed("2.1.63", range)).not.toThrow();
    expect(() => assertClaudeCodeVersionAllowed("2.5.0", range)).not.toThrow();
  });

  it("rejects versions outside the configured range", () => {
    const range = parseVersionRange({ min: "2.1.63", max: "2.5.0" });

    expect(() => assertClaudeCodeVersionAllowed("2.1.62", range)).toThrow(/below/);
    expect(() => assertClaudeCodeVersionAllowed("2.5.1", range)).toThrow(/above/);
  });

  it("rejects an inverted range at startup", () => {
    expect(() => parseVersionRange({ min: "2.5.0", max: "2.1.63" })).toThrow(/minimum/);
  });
});
