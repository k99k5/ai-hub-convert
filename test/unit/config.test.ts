import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const baseEnvironment = {
  UPSTREAM_BASE_URL: "https://gateway.example.test/v1",
};

describe("loadConfig", () => {
  it("defaults CORS to wildcard and supports exact origin lists", () => {
    expect(loadConfig(baseEnvironment).server.corsOrigins).toBe("*");
    expect(
      loadConfig({
        ...baseEnvironment,
        CORS_ORIGINS: " https://app.example, http://localhost:5173 ",
      }).server.corsOrigins,
    ).toEqual(["https://app.example", "http://localhost:5173"]);
    for (const value of ["https://app.example,", "*,https://app.example", "https://*.example"]) {
      expect(() => loadConfig({ ...baseEnvironment, CORS_ORIGINS: value })).toThrow("CORS_ORIGINS");
    }
  });

  it("loads conservative defaults", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.server).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      anthropicPingIntervalMs: 15_000,
      sseHeartbeatIntervalMs: 15_000,
    });
    expect(config.websocket).toEqual({
      pingIntervalMs: 30_000,
      maxConnectionMs: 3_600_000,
      maxPendingRequests: 64,
      historyLimitBytes: 32 * 1024 * 1024,
    });
    expect(config.responsesHistory).toEqual({
      ttlMs: 300_000,
      maxCredentialBytes: 32 * 1024 * 1024,
      maxBytes: 128 * 1024 * 1024,
    });
    expect(config.claudeCode).toMatchObject({
      promptCacheBreakpointsEnabled: true,
      readToolCompatEnabled: true,
      syntheticThinkingSignatureEnabled: true,
      versionRange: {},
    });
    expect(config.upstream).toMatchObject({
      protocol: "chat",
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

  it("validates WebSocket resource limits and optional heartbeats", () => {
    expect(
      loadConfig({ ...baseEnvironment, WEBSOCKET_PING_INTERVAL_MS: "0" }).websocket.pingIntervalMs,
    ).toBe(0);
    for (const [name, value] of [
      ["WEBSOCKET_PING_INTERVAL_MS", "-1"],
      ["WEBSOCKET_MAX_CONNECTION_MS", "0"],
      ["WEBSOCKET_MAX_CONNECTION_MS", "3600001"],
      ["WEBSOCKET_MAX_PENDING_REQUESTS", "1.5"],
      ["WEBSOCKET_HISTORY_LIMIT_BYTES", "0"],
    ] as const) {
      expect(() => loadConfig({ ...baseEnvironment, [name]: value })).toThrow(name);
    }
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

  it("configures HTTP Responses history retention and rejects invalid budgets", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        RESPONSES_HISTORY_TTL_MS: "60000",
        RESPONSES_HISTORY_MAX_CREDENTIAL_BYTES: "4096",
        RESPONSES_HISTORY_MAX_BYTES: "16384",
      }).responsesHistory,
    ).toEqual({ ttlMs: 60_000, maxCredentialBytes: 4096, maxBytes: 16384 });
    for (const name of [
      "RESPONSES_HISTORY_TTL_MS",
      "RESPONSES_HISTORY_MAX_CREDENTIAL_BYTES",
      "RESPONSES_HISTORY_MAX_BYTES",
    ]) {
      for (const value of ["0", "-1", "1.5", "invalid"]) {
        expect(() => loadConfig({ ...baseEnvironment, [name]: value })).toThrow(name);
      }
    }
  });

  it("allows explicit Responses mode and rejects unknown upstream protocols", () => {
    expect(
      loadConfig({ ...baseEnvironment, UPSTREAM_PROTOCOL: "responses" }).upstream.protocol,
    ).toBe("responses");
    expect(loadConfig({ ...baseEnvironment, UPSTREAM_PROTOCOL: "chat" }).upstream.protocol).toBe(
      "chat",
    );
    expect(() => loadConfig({ ...baseEnvironment, UPSTREAM_PROTOCOL: "auto" })).toThrow(
      /UPSTREAM_PROTOCOL/,
    );
  });

  it("configures bounded in-memory conversation storage", () => {
    expect(loadConfig(baseEnvironment).conversations).toEqual({
      ttlMs: 30 * 60_000,
      maxCredentialBytes: 32 * 1024 * 1024,
      maxBytes: 128 * 1024 * 1024,
    });
    expect(
      loadConfig({
        ...baseEnvironment,
        CONVERSATIONS_TTL_MS: "60000",
        CONVERSATIONS_MAX_CREDENTIAL_BYTES: "2048",
        CONVERSATIONS_MAX_BYTES: "4096",
      }).conversations,
    ).toEqual({ ttlMs: 60_000, maxCredentialBytes: 2048, maxBytes: 4096 });
    for (const name of [
      "CONVERSATIONS_TTL_MS",
      "CONVERSATIONS_MAX_CREDENTIAL_BYTES",
      "CONVERSATIONS_MAX_BYTES",
    ]) {
      for (const value of ["0", "-1", "1.5", "invalid"])
        expect(() => loadConfig({ ...baseEnvironment, [name]: value })).toThrow(name);
    }
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

  it("loads or disables OpenAI SSE heartbeats and rejects invalid intervals", () => {
    expect(
      loadConfig({ ...baseEnvironment, SSE_HEARTBEAT_INTERVAL_MS: "250" }).server
        .sseHeartbeatIntervalMs,
    ).toBe(250);
    expect(
      loadConfig({ ...baseEnvironment, SSE_HEARTBEAT_INTERVAL_MS: "0" }).server
        .sseHeartbeatIntervalMs,
    ).toBe(0);
    for (const interval of ["-1", "1.5", "invalid"]) {
      expect(() => loadConfig({ ...baseEnvironment, SSE_HEARTBEAT_INTERVAL_MS: interval })).toThrow(
        /SSE_HEARTBEAT_INTERVAL_MS/,
      );
    }
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
