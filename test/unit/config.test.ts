import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const baseEnvironment = {
  UPSTREAM_BASE_URL: "https://gateway.example.test/v1",
};

describe("loadConfig", () => {
  it("loads conservative defaults", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      anthropicPingIntervalMs: 15_000,
    });
    expect(config.claudeCode).toMatchObject({
      promptCacheBreakpointsEnabled: true,
      readToolCompatEnabled: true,
      syntheticThinkingSignatureEnabled: true,
      versionRange: {},
    });
    expect(config.upstream).toMatchObject({
      toolArgumentLimitBytes: 1024 * 1024,
      streamToolArgumentLimitBytes: 8 * 1024 * 1024,
      sseFrameLimitBytes: 8 * 1024 * 1024,
      outputItemLimitBytes: 8 * 1024 * 1024,
      streamOutputLimitBytes: 32 * 1024 * 1024,
      jsonBodyLimitBytes: 32 * 1024 * 1024,
      errorBodyLimitBytes: 64 * 1024,
    });
    expect(config.upstream.baseUrl.href).toBe("https://gateway.example.test/v1/");
  });

  it("loads explicit stream limits", () => {
    const config = loadConfig({
      ...baseEnvironment,
      UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES: "2048",
      UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES: "8192",
      UPSTREAM_SSE_FRAME_LIMIT_BYTES: "16384",
      UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "32768",
      UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES: "65536",
      UPSTREAM_JSON_BODY_LIMIT_BYTES: "131072",
      UPSTREAM_ERROR_BODY_LIMIT_BYTES: "4096",
    });

    expect(config.upstream).toMatchObject({
      toolArgumentLimitBytes: 2048,
      streamToolArgumentLimitBytes: 8192,
      sseFrameLimitBytes: 16384,
      outputItemLimitBytes: 32768,
      streamOutputLimitBytes: 65536,
      jsonBodyLimitBytes: 131072,
      errorBodyLimitBytes: 4096,
    });
  });

  it("rejects invalid stream limits", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES: "0" }),
    ).toThrow(/UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES/);
    expect(() =>
      loadConfig({ ...baseEnvironment, UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES: "many" }),
    ).toThrow(/UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES/);
    expect(() => loadConfig({ ...baseEnvironment, UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES: "0" })).toThrow(
      /UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES/,
    );
    expect(() =>
      loadConfig({ ...baseEnvironment, UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES: "many" }),
    ).toThrow(/UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES/);
    expect(() => loadConfig({ ...baseEnvironment, UPSTREAM_JSON_BODY_LIMIT_BYTES: "0" })).toThrow(
      /UPSTREAM_JSON_BODY_LIMIT_BYTES/,
    );
    expect(() =>
      loadConfig({ ...baseEnvironment, UPSTREAM_ERROR_BODY_LIMIT_BYTES: "many" }),
    ).toThrow(/UPSTREAM_ERROR_BODY_LIMIT_BYTES/);
  });

  it("loads an explicit Anthropic ping interval", () => {
    const config = loadConfig({ ...baseEnvironment, ANTHROPIC_PING_INTERVAL_MS: "250" });

    expect(config.server.anthropicPingIntervalMs).toBe(250);
    expect(() => loadConfig({ ...baseEnvironment, ANTHROPIC_PING_INTERVAL_MS: "0" })).toThrow(
      /ANTHROPIC_PING_INTERVAL_MS/,
    );
  });

  it("rejects malformed booleans instead of using truthiness", () => {
    expect(() => loadConfig({ ...baseEnvironment, READ_TOOL_COMPAT_ENABLED: "yes" })).toThrow(
      /READ_TOOL_COMPAT_ENABLED/,
    );
  });

  it("requires an explicit opt-in for insecure upstream HTTP", () => {
    expect(() => loadConfig({ UPSTREAM_BASE_URL: "http://gateway.example.test/v1" })).toThrow(
      /HTTPS/,
    );
  });
});
