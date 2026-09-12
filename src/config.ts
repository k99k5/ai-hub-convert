import { parseVersionRange, type VersionRange } from "./profiles/claude-code/version.js";

export interface AppConfig {
  server: {
    host: string;
    port: number;
    bodyLimitBytes: number;
    connectionTimeoutMs: number;
    requestTimeoutMs: number;
    shutdownGraceMs: number;
    anthropicPingIntervalMs: number;
  };
  upstream: {
    baseUrl: URL;
    protocol: "chat" | "responses";
    timeoutMs: number;
    firstByteTimeoutMs: number;
    streamIdleTimeoutMs: number;
    toolArgumentLimitBytes: number;
    streamToolArgumentLimitBytes: number;
    sseFrameLimitBytes: number;
    outputItemLimitBytes: number;
    streamOutputLimitBytes: number;
    jsonBodyLimitBytes: number;
    errorBodyLimitBytes: number;
  };
  claudeCode: {
    versionRange: VersionRange;
    promptCacheBreakpointsEnabled: boolean;
    readToolCompatEnabled: boolean;
    syntheticThinkingSignatureEnabled: boolean;
  };
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function loadConfig(environment: Environment = process.env): AppConfig {
  const allowInsecureUpstream = parseBoolean(
    environment.ALLOW_INSECURE_UPSTREAM,
    "ALLOW_INSECURE_UPSTREAM",
    false,
  );
  const baseUrl = parseUpstreamUrl(environment.UPSTREAM_BASE_URL, allowInsecureUpstream);

  return {
    server: {
      host: environment.HOST || "127.0.0.1",
      port: parseInteger(environment.PORT, "PORT", 3000, { min: 1, max: 65_535 }),
      bodyLimitBytes: parseInteger(
        environment.BODY_LIMIT_BYTES,
        "BODY_LIMIT_BYTES",
        32 * 1024 * 1024,
        {
          min: 1,
        },
      ),
      connectionTimeoutMs: parseInteger(
        environment.CONNECTION_TIMEOUT_MS,
        "CONNECTION_TIMEOUT_MS",
        0,
        { min: 0 },
      ),
      requestTimeoutMs: parseInteger(environment.REQUEST_TIMEOUT_MS, "REQUEST_TIMEOUT_MS", 30_000, {
        min: 1,
      }),
      shutdownGraceMs: parseInteger(environment.SHUTDOWN_GRACE_MS, "SHUTDOWN_GRACE_MS", 10_000, {
        min: 1,
      }),
      anthropicPingIntervalMs: parseInteger(
        environment.ANTHROPIC_PING_INTERVAL_MS,
        "ANTHROPIC_PING_INTERVAL_MS",
        15_000,
        { min: 1 },
      ),
    },
    upstream: {
      baseUrl,
      protocol: parseUpstreamProtocol(environment.UPSTREAM_PROTOCOL),
      timeoutMs: parseInteger(environment.UPSTREAM_TIMEOUT_MS, "UPSTREAM_TIMEOUT_MS", 10 * 60_000, {
        min: 1,
      }),
      firstByteTimeoutMs: parseInteger(
        environment.UPSTREAM_FIRST_BYTE_TIMEOUT_MS,
        "UPSTREAM_FIRST_BYTE_TIMEOUT_MS",
        60_000,
        { min: 1 },
      ),
      streamIdleTimeoutMs: parseInteger(
        environment.UPSTREAM_STREAM_IDLE_TIMEOUT_MS,
        "UPSTREAM_STREAM_IDLE_TIMEOUT_MS",
        120_000,
        { min: 1 },
      ),
      toolArgumentLimitBytes: parseInteger(
        environment.UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES,
        "UPSTREAM_TOOL_ARGUMENT_LIMIT_BYTES",
        1024 * 1024,
        { min: 1 },
      ),
      streamToolArgumentLimitBytes: parseInteger(
        environment.UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES,
        "UPSTREAM_STREAM_TOOL_ARGUMENT_LIMIT_BYTES",
        8 * 1024 * 1024,
        { min: 1 },
      ),
      sseFrameLimitBytes: parseInteger(
        environment.UPSTREAM_SSE_FRAME_LIMIT_BYTES,
        "UPSTREAM_SSE_FRAME_LIMIT_BYTES",
        8 * 1024 * 1024,
        { min: 1 },
      ),
      outputItemLimitBytes: parseInteger(
        environment.UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES,
        "UPSTREAM_OUTPUT_ITEM_LIMIT_BYTES",
        8 * 1024 * 1024,
        { min: 1 },
      ),
      streamOutputLimitBytes: parseInteger(
        environment.UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES,
        "UPSTREAM_STREAM_OUTPUT_LIMIT_BYTES",
        32 * 1024 * 1024,
        { min: 1 },
      ),
      jsonBodyLimitBytes: parseInteger(
        environment.UPSTREAM_JSON_BODY_LIMIT_BYTES,
        "UPSTREAM_JSON_BODY_LIMIT_BYTES",
        32 * 1024 * 1024,
        { min: 1 },
      ),
      errorBodyLimitBytes: parseInteger(
        environment.UPSTREAM_ERROR_BODY_LIMIT_BYTES,
        "UPSTREAM_ERROR_BODY_LIMIT_BYTES",
        64 * 1024,
        { min: 1 },
      ),
    },
    claudeCode: {
      versionRange: parseVersionRange({
        ...(environment.CLAUDE_CODE_MIN_VERSION
          ? { min: environment.CLAUDE_CODE_MIN_VERSION }
          : {}),
        ...(environment.CLAUDE_CODE_MAX_VERSION
          ? { max: environment.CLAUDE_CODE_MAX_VERSION }
          : {}),
      }),
      promptCacheBreakpointsEnabled: parseBoolean(
        environment.PROMPT_CACHE_BREAKPOINTS_ENABLED,
        "PROMPT_CACHE_BREAKPOINTS_ENABLED",
        true,
      ),
      readToolCompatEnabled: parseBoolean(
        environment.READ_TOOL_COMPAT_ENABLED,
        "READ_TOOL_COMPAT_ENABLED",
        true,
      ),
      syntheticThinkingSignatureEnabled: parseBoolean(
        environment.SYNTHETIC_THINKING_SIGNATURE_ENABLED,
        "SYNTHETIC_THINKING_SIGNATURE_ENABLED",
        true,
      ),
    },
  };
}

function parseUpstreamProtocol(value: string | undefined): "chat" | "responses" {
  if (value === undefined || value === "" || value === "chat") return "chat";
  if (value === "responses") return "responses";
  throw new Error("UPSTREAM_PROTOCOL must be either chat or responses");
}

function parseUpstreamUrl(value: string | undefined, allowInsecure: boolean): URL {
  if (!value) {
    throw new Error("UPSTREAM_BASE_URL is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UPSTREAM_BASE_URL must be a valid absolute URL");
  }

  if (url.username || url.password) {
    throw new Error("UPSTREAM_BASE_URL must not contain credentials");
  }
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("UPSTREAM_BASE_URL must use HTTPS unless ALLOW_INSECURE_UPSTREAM=true");
  }
  if (url.search || url.hash) {
    throw new Error("UPSTREAM_BASE_URL must not contain a query string or fragment");
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function parseBoolean(value: string | undefined, name: string, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  limits: { min?: number; max?: number } = {},
): number {
  const parsed = value === undefined || value === "" ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  if (limits.min !== undefined && parsed < limits.min) {
    throw new Error(`${name} must be at least ${limits.min}`);
  }
  if (limits.max !== undefined && parsed > limits.max) {
    throw new Error(`${name} must be at most ${limits.max}`);
  }
  return parsed;
}
