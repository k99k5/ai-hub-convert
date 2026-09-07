import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { SSEPluginOptions } from "@fastify/sse";
import type { FastifyPluginAsync } from "fastify";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";
import type { CanonicalEvent } from "./core/events.js";
import type { CanonicalRequest, CanonicalResponse } from "./core/ir.js";
import { createRequestAbortScope } from "./http/abort.js";
import {
  AuthenticationError,
  extractAnthropicApiKey,
  extractResponsesApiKey,
} from "./http/auth.js";
import { sendAnthropicError, sendOpenAIRequestError } from "./http/errors.js";
import { preparePromptCacheAttempt } from "./policies/cache/attempt.js";
import {
  GENERIC_PROMPT_CACHE_CAPABILITIES,
  type PromptCacheCapabilities,
} from "./policies/cache/capabilities.js";
import type { PromptCacheSidecar } from "./policies/cache/sidecar.js";
import { registerHealthRoutes } from "./http/health.js";
import {
  AnthropicMessagesBodySchema,
  AnthropicTokenCountBodySchema,
  OpenAIResponsesBodySchema,
} from "./http/schemas.js";
import { ClientSseSender } from "./http/sse.js";
import { mapUpstreamError } from "./http/upstream-errors.js";
import { normalizeReadToolArguments } from "./policies/read-tool.js";
import { finalizeThinkingBlock } from "./policies/thinking-signature.js";
import {
  assertWebSearchSupported,
  createDefaultWebSearchRegistry,
} from "./providers/web-search/preflight.js";
import { WebSearchUnsupportedError } from "./providers/web-search/unsupported.js";
import {
  assertClaudeCodeVersionAllowed,
  ClaudeCodeVersionRangeError,
  extractClaudeCodeVersion,
} from "./profiles/claude-code/version.js";
import {
  AnthropicDecodeError,
  decodeAnthropicRequestWithSidecar,
  decodeAnthropicTokenCountRequest,
} from "./protocols/anthropic/decode.js";
import { encodeAnthropicResponse } from "./protocols/anthropic/encode.js";
import {
  AnthropicStreamEncoder,
  type AnthropicSseFrame,
  type AnthropicStreamEncoderOptions,
} from "./protocols/anthropic/stream-encode.js";
import { decodeChatResponse } from "./protocols/openai-chat/decode.js";
import { encodeChatRequest } from "./protocols/openai-chat/encode.js";
import { ChatStreamDecoder } from "./protocols/openai-chat/stream-decode.js";
import { decodeResponsesRequest } from "./protocols/openai-responses/request-decode.js";
import { encodeResponsesResponse } from "./protocols/openai-responses/response-encode.js";
import { decodeResponsesResponse } from "./protocols/openai-responses/decode.js";
import { encodeResponsesRequest } from "./protocols/openai-responses/encode.js";
import { ResponsesStreamDecoder } from "./protocols/openai-responses/stream-decode.js";
import {
  ResponsesStreamEncoder,
  type ResponsesSseFrame,
} from "./protocols/openai-responses/stream-encode.js";
import {
  decodeResponsesInputTokensResponse,
  encodeResponsesInputTokensRequest,
} from "./protocols/openai-responses/input-tokens.js";
import { OpenAIAdapterError as ChatAdapterError } from "./protocols/openai-chat/types.js";
import { OpenAIAdapterError } from "./protocols/openai-responses/types.js";
import { ActiveStreamRegistry } from "./stream/active-streams.js";
import { StreamOutputLimitError, type StreamOutputLimits } from "./stream/output-limits.js";
import { PingedIterator } from "./stream/ping.js";
import { parseSseStream } from "./stream/sse-parser.js";
import { ToolArgumentLimitError, type ToolArgumentLimits } from "./stream/tool-argument-limits.js";
import { UpstreamClient, UpstreamHttpError } from "./upstream/client.js";
import { shouldFallbackToChat } from "./upstream/routing.js";
import {
  decodeWebSearchExecutionsHeader,
  getWebSearchExecutions,
  getWebSearchRequestCount,
  type WebSearchExecution,
} from "./upstream/web-search-loop.js";

const require = createRequire(import.meta.url);
const fastifySSE = require("@fastify/sse") as FastifyPluginAsync<SSEPluginOptions>;

interface BuildAppOptions {
  config: AppConfig;
  logger?: FastifyServerOptions["logger"];
  upstreamFetch?: typeof globalThis.fetch;
}

interface AnthropicMessageBody {
  system?: string | Array<{ type?: string; text?: string }>;
}

type RouteProtocol = "anthropic" | "openai-responses";

interface FastifyBoundaryError extends Error {
  code?: string;
  validation?: unknown;
}

interface StreamTimeoutOptions {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  maxFrameBytes: number;
  onTimeout: (error: Error) => void;
}

interface AnthropicCompletionResult {
  response: CanonicalResponse;
  webSearchExecutions: WebSearchExecution[];
}

function toolArgumentLimits(config: AppConfig): ToolArgumentLimits {
  return {
    perCallBytes: config.upstream.toolArgumentLimitBytes,
    perStreamBytes: config.upstream.streamToolArgumentLimitBytes,
  };
}

function outputLimits(config: AppConfig): StreamOutputLimits {
  return {
    perItemBytes: config.upstream.outputItemLimitBytes,
    perStreamBytes: config.upstream.streamOutputLimitBytes,
  };
}

function routeProtocol(url: string): RouteProtocol {
  return url === "/v1/responses" ? "openai-responses" : "anthropic";
}

function isBoundaryError(error: unknown): error is FastifyBoundaryError {
  return error instanceof Error;
}

function isProtocolAdapterError(error: unknown): boolean {
  return error instanceof OpenAIAdapterError || error instanceof ChatAdapterError;
}

function debugValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function debugAnthropicBodyShape(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { bodyType: Array.isArray(body) ? "array" : body === null ? "null" : typeof body };
  }
  const record = body as Record<string, unknown>;
  const messages = record.messages;
  const tools = record.tools;
  const outputConfig =
    typeof record.output_config === "object" &&
    record.output_config !== null &&
    !Array.isArray(record.output_config)
      ? (record.output_config as Record<string, unknown>)
      : undefined;
  return {
    requestKeyCount: Object.keys(record).length,
    modelType: typeof record.model,
    maxTokensType: typeof record.max_tokens,
    ...(typeof record.max_tokens === "number" ? { maxTokens: record.max_tokens } : {}),
    messagesType: Array.isArray(messages) ? "array" : typeof messages,
    ...(Array.isArray(messages) ? { messageCount: messages.length } : {}),
    systemType: Array.isArray(record.system) ? "array" : typeof record.system,
    toolsType: Array.isArray(tools) ? "array" : typeof tools,
    ...(Array.isArray(tools) ? { toolCount: tools.length } : {}),
    outputConfigType:
      record.output_config === null
        ? "null"
        : Array.isArray(record.output_config)
          ? "array"
          : typeof record.output_config,
    ...(outputConfig === undefined
      ? {}
      : {
          outputConfigKeyCount: Object.keys(outputConfig).length,
          outputConfigHasEffort: Object.hasOwn(outputConfig, "effort"),
          outputConfigHasFormat: Object.hasOwn(outputConfig, "format"),
          outputEffortType: debugValueType(outputConfig.effort),
          outputFormatType: debugValueType(outputConfig.format),
        }),
    streamType: typeof record.stream,
    ...(typeof record.stream === "boolean" ? { stream: record.stream } : {}),
  };
}

function debugBoundaryValidation(validation: unknown): unknown {
  if (!Array.isArray(validation)) {
    return validation === undefined ? undefined : { type: typeof validation };
  }
  return validation.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { type: typeof raw };
    }
    const item = raw as Record<string, unknown>;
    const params =
      typeof item.params === "object" && item.params !== null && !Array.isArray(item.params)
        ? (item.params as Record<string, unknown>)
        : undefined;
    return {
      ...(typeof item.schemaPath === "string" ? { schemaPath: item.schemaPath } : {}),
      ...(typeof item.keyword === "string" ? { keyword: item.keyword } : {}),
      hasInstancePath: typeof item.instancePath === "string",
      hasMessage: typeof item.message === "string",
      hasMissingProperty: params?.missingProperty !== undefined,
      hasAdditionalProperty: params?.additionalProperty !== undefined,
    };
  });
}

function debugAnthropic400(
  event: string,
  requestId: string,
  body: unknown,
  details: Record<string, unknown>,
): void {
  process.stderr.write(
    `[web-search-debug] ${JSON.stringify({
      event,
      requestId,
      ...debugAnthropicBodyShape(body),
      ...details,
    })}\n`,
  );
}

function addWebSearchUsage(
  response: CanonicalResponse,
  upstreamResponse: unknown,
): CanonicalResponse {
  const webSearchRequests = getWebSearchRequestCount(upstreamResponse);
  return webSearchRequests === undefined
    ? response
    : { ...response, usage: { ...response.usage, webSearchRequests } };
}

function readWebSearchUsageHeader(response: Response): number | undefined {
  const value = response.headers.get("x-ai-hub-web-search-requests");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function addWebSearchUsageToEvent(
  event: CanonicalEvent,
  webSearchRequests: number | undefined,
): CanonicalEvent {
  if (event.type !== "response_complete" || webSearchRequests === undefined) {
    return event;
  }
  return { ...event, usage: { ...event.usage, webSearchRequests } };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  const upstream = new UpstreamClient({
    baseUrl: config.upstream.baseUrl,
    timeoutMs: config.upstream.timeoutMs,
    jsonBodyLimitBytes: config.upstream.jsonBodyLimitBytes,
    errorBodyLimitBytes: config.upstream.errorBodyLimitBytes,
    ...(options.upstreamFetch === undefined ? {} : { fetch: options.upstreamFetch }),
  });
  const activeStreams = new ActiveStreamRegistry();
  const webSearchProviders = createDefaultWebSearchRegistry();
  const app = Fastify({
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    bodyLimit: config.server.bodyLimitBytes,
    connectionTimeout: config.server.connectionTimeoutMs,
    requestTimeout: config.server.requestTimeoutMs,
    genReqId: () => `req_${randomUUID()}`,
    logger: options.logger ?? {
      redact: {
        paths: ["req.headers.authorization", "req.headers.x-api-key"],
        censor: "[REDACTED]",
      },
    },
  });

  app.addHook("preClose", async () => {
    activeStreams.abortAll();
  });
  app.register(registerHealthRoutes);
  app.register(async (api) => {
    await api.register(fastifySSE, { heartbeatInterval: 0 });
    api.setErrorHandler((error, request, reply) => {
      const protocol = routeProtocol(request.url.split("?", 1)[0] ?? request.url);
      const boundaryError = isBoundaryError(error) ? error : undefined;
      if (boundaryError?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return protocol === "anthropic"
          ? sendAnthropicError(reply, 413, "request_too_large", "Request body is too large")
          : sendOpenAIRequestError(reply, 413, "request_too_large", "Request body is too large");
      }
      if (
        boundaryError?.code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        boundaryError?.validation !== undefined
      ) {
        if (protocol === "anthropic") {
          debugAnthropic400("anthropic_boundary_400", request.id, request.body, {
            errorCode: boundaryError?.code,
            validation: debugBoundaryValidation(boundaryError?.validation),
          });
        }
        return protocol === "anthropic"
          ? sendAnthropicError(reply, 400, "invalid_request_error", "Invalid request body")
          : sendOpenAIRequestError(reply, 400, "invalid_request", "Invalid request body");
      }
      throw error;
    });

    api.post<{ Body: AnthropicMessageBody }>(
      "/v1/messages",
      {
        schema: { body: AnthropicMessagesBodySchema },
        sse: { kind: "manual", heartbeat: false },
      },
      async (request, reply) => {
        const version = extractClaudeCodeVersion({
          ...(request.body?.system !== undefined ? { system: request.body.system } : {}),
          ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
        });
        const isClaudeCode = version.source !== "none";

        if (isClaudeCode) {
          try {
            assertClaudeCodeVersionAllowed(version.version, config.claudeCode.versionRange);
          } catch (error) {
            if (error instanceof ClaudeCodeVersionRangeError) {
              return sendAnthropicError(
                reply,
                400,
                "invalid_request_error",
                `Claude Code version is ${error.direction} the supported range`,
              );
            }
            throw error;
          }
        }

        let apiKey: string;
        let canonicalRequest: CanonicalRequest;
        let promptCacheSidecar: PromptCacheSidecar;
        try {
          apiKey = extractAnthropicApiKey(request.headers);
          const decoded = decodeAnthropicRequestWithSidecar(request.body);
          canonicalRequest = decoded.request;
          promptCacheSidecar = decoded.promptCache;
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return sendAnthropicError(reply, 401, "authentication_error", error.message);
          }
          if (error instanceof AnthropicDecodeError) {
            debugAnthropic400("anthropic_decode_400", request.id, request.body, {
              decodeCode: error.code,
              decodeMessage: error.message,
            });
            return sendAnthropicError(reply, 400, "invalid_request_error", error.message);
          }
          throw error;
        }

        try {
          assertWebSearchSupported(canonicalRequest, webSearchProviders);
        } catch (error) {
          if (error instanceof WebSearchUnsupportedError) {
            return sendAnthropicError(reply, 501, "api_error", "Web Search is not supported");
          }
          throw error;
        }

        if (canonicalRequest.stream) {
          const abortScope = createRequestAbortScope(request.raw, reply.raw);
          const removeActiveStream = activeStreams.add(abortScope);
          const clientStream = new ClientSseSender(reply);
          reply.sse.onClose(() => abortScope.abort(new Error("Client disconnected")));
          try {
            await streamAnthropicResponse(
              upstream,
              canonicalRequest,
              apiKey,
              abortScope.signal,
              promptCacheSidecar,
              isClaudeCode && config.claudeCode.promptCacheBreakpointsEnabled,
              GENERIC_PROMPT_CACHE_CAPABILITIES,
              {
                readToolCompatEnabled: isClaudeCode && config.claudeCode.readToolCompatEnabled,
                syntheticThinkingSignatureEnabled:
                  isClaudeCode && config.claudeCode.syntheticThinkingSignatureEnabled,
                toolArgumentLimits: toolArgumentLimits(config),
                outputLimits: outputLimits(config),
              },
              {
                firstByteTimeoutMs: config.upstream.firstByteTimeoutMs,
                idleTimeoutMs: config.upstream.streamIdleTimeoutMs,
                maxFrameBytes: config.upstream.sseFrameLimitBytes,
                onTimeout: (error) => abortScope.abort(error),
              },
              config.server.anthropicPingIntervalMs,
              clientStream.send,
            );
            return;
          } catch (error) {
            abortScope.abort(error);
            if (!reply.raw.headersSent) {
              if (isProtocolAdapterError(error)) {
                return sendAnthropicError(
                  reply,
                  400,
                  "invalid_request_error",
                  "The request contains content that is not supported for protocol conversion",
                );
              }
              const mapped = mapUpstreamError("anthropic", error, request.id);
              return reply.code(mapped.status).send(mapped.body);
            }
            await clientStream.sendError({
              event: "error",
              data: {
                type: "error",
                error: { type: "api_error", message: "The upstream stream failed" },
              },
            });
            return;
          } finally {
            removeActiveStream();
            abortScope.dispose();
          }
        }

        const abortScope = createRequestAbortScope(request.raw, reply.raw);
        try {
          const completion = await requestAnthropicCompletion(
            upstream,
            canonicalRequest,
            apiKey,
            abortScope.signal,
            promptCacheSidecar,
            isClaudeCode && config.claudeCode.promptCacheBreakpointsEnabled,
            GENERIC_PROMPT_CACHE_CAPABILITIES,
          );
          const normalizedResponse = normalizeResponseToolArguments(
            completion.response,
            isClaudeCode && config.claudeCode.readToolCompatEnabled,
          );
          return reply.send(
            encodeAnthropicResponse(normalizedResponse, {
              finalizeThinking: (reasoning) =>
                finalizeThinkingBlock(reasoning, {
                  enabled: isClaudeCode && config.claudeCode.syntheticThinkingSignatureEnabled,
                }),
              webSearchExecutions: completion.webSearchExecutions,
            }),
          );
        } catch (error) {
          if (isProtocolAdapterError(error)) {
            return sendAnthropicError(
              reply,
              400,
              "invalid_request_error",
              "The request contains content that is not supported for protocol conversion",
            );
          }
          const mapped = mapUpstreamError("anthropic", error, request.id);
          return reply.code(mapped.status).send(mapped.body);
        } finally {
          abortScope.dispose();
        }
      },
    );

    api.post<{ Body: AnthropicMessageBody }>(
      "/v1/messages/count_tokens",
      { schema: { body: AnthropicTokenCountBodySchema } },
      async (request, reply) => {
        const version = extractClaudeCodeVersion({
          ...(request.body?.system !== undefined ? { system: request.body.system } : {}),
          ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
        });
        if (version.source !== "none") {
          try {
            assertClaudeCodeVersionAllowed(version.version, config.claudeCode.versionRange);
          } catch (error) {
            if (error instanceof ClaudeCodeVersionRangeError) {
              return sendAnthropicError(
                reply,
                400,
                "invalid_request_error",
                `Claude Code version is ${error.direction} the supported range`,
              );
            }
            throw error;
          }
        }

        let apiKey: string;
        let canonicalRequest: CanonicalRequest;
        try {
          apiKey = extractAnthropicApiKey(request.headers);
          canonicalRequest = decodeAnthropicTokenCountRequest(request.body);
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return sendAnthropicError(reply, 401, "authentication_error", error.message);
          }
          if (error instanceof AnthropicDecodeError) {
            debugAnthropic400("anthropic_decode_400", request.id, request.body, {
              decodeCode: error.code,
              decodeMessage: error.message,
            });
            return sendAnthropicError(reply, 400, "invalid_request_error", error.message);
          }
          throw error;
        }

        try {
          assertWebSearchSupported(canonicalRequest, webSearchProviders);
        } catch (error) {
          if (error instanceof WebSearchUnsupportedError) {
            return sendAnthropicError(reply, 501, "api_error", "Web Search is not supported");
          }
          throw error;
        }

        const abortScope = createRequestAbortScope(request.raw, reply.raw);
        try {
          const upstreamResponse = await upstream.postJson(
            "responses/input_tokens",
            encodeResponsesInputTokensRequest(canonicalRequest),
            apiKey,
            abortScope.signal,
          );
          return reply.send({
            input_tokens: decodeResponsesInputTokensResponse(upstreamResponse),
          });
        } catch (error) {
          if (isProtocolAdapterError(error)) {
            return sendAnthropicError(
              reply,
              400,
              "invalid_request_error",
              "The request contains content that is not supported for protocol conversion",
            );
          }
          const mapped = mapUpstreamError("anthropic", error, request.id);
          return reply.code(mapped.status).send(mapped.body);
        } finally {
          abortScope.dispose();
        }
      },
    );

    api.post<{ Body: unknown }>(
      "/v1/responses",
      {
        schema: { body: OpenAIResponsesBodySchema },
        sse: { kind: "manual", heartbeat: false },
      },
      async (request, reply) => {
        let apiKey: string;
        let canonicalRequest: CanonicalRequest;
        try {
          apiKey = extractResponsesApiKey(request.headers);
          canonicalRequest = decodeResponsesRequest(request.body);
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return reply.code(401).send({
              error: {
                message: error.message,
                type: "authentication_error",
                code: "invalid_api_key",
              },
              request_id: request.id,
            });
          }
          if (error instanceof OpenAIAdapterError) {
            return reply.code(400).send({
              error: {
                message: error.message,
                type: "invalid_request_error",
                code: "invalid_request",
              },
              request_id: request.id,
            });
          }
          throw error;
        }

        try {
          assertWebSearchSupported(canonicalRequest, webSearchProviders);
        } catch (error) {
          if (error instanceof WebSearchUnsupportedError) {
            return reply.code(501).send({
              error: {
                message: "Web Search is not supported",
                type: "server_error",
                code: "web_search_unsupported",
              },
              request_id: request.id,
            });
          }
          throw error;
        }

        if (canonicalRequest.stream) {
          const abortScope = createRequestAbortScope(request.raw, reply.raw);
          const removeActiveStream = activeStreams.add(abortScope);
          const clientStream = new ClientSseSender(reply);
          reply.sse.onClose(() => abortScope.abort(new Error("Client disconnected")));
          try {
            await streamResponsesResponse(
              upstream,
              canonicalRequest,
              apiKey,
              abortScope.signal,
              toolArgumentLimits(config),
              outputLimits(config),
              {
                firstByteTimeoutMs: config.upstream.firstByteTimeoutMs,
                idleTimeoutMs: config.upstream.streamIdleTimeoutMs,
                maxFrameBytes: config.upstream.sseFrameLimitBytes,
                onTimeout: (error) => abortScope.abort(error),
              },
              clientStream.send,
            );
            return;
          } catch (error) {
            abortScope.abort(error);
            if (!reply.raw.headersSent) {
              const mapped = mapUpstreamError("openai-responses", error, request.id);
              return reply.code(mapped.status).send(mapped.body);
            }
            await clientStream.sendError({
              event: "error",
              data: {
                type: "error",
                code:
                  error instanceof ToolArgumentLimitError || error instanceof StreamOutputLimitError
                    ? error.code
                    : "upstream_stream_error",
                message: "The upstream stream failed",
                param: null,
              },
            });
            return;
          } finally {
            removeActiveStream();
            abortScope.dispose();
          }
        }

        const abortScope = createRequestAbortScope(request.raw, reply.raw);
        try {
          const upstreamResponse = await upstream.postJson(
            "responses",
            encodeResponsesRequest(canonicalRequest, {
              store: false,
              replaySourceExtensions: true,
              promptCache: { kind: "none" },
            }),
            apiKey,
            abortScope.signal,
          );
          return reply.send(
            encodeResponsesResponse(
              decodeResponsesResponse(upstreamResponse, { preserveWireMetadata: true }),
            ),
          );
        } catch (error) {
          const mapped = mapUpstreamError("openai-responses", error, request.id);
          return reply.code(mapped.status).send(mapped.body);
        } finally {
          abortScope.dispose();
        }
      },
    );
  });

  return app;
}

async function streamResponsesResponse(
  upstream: UpstreamClient,
  request: CanonicalRequest,
  apiKey: string,
  signal: AbortSignal,
  argumentLimits: ToolArgumentLimits,
  streamOutputLimits: StreamOutputLimits,
  timeoutOptions: StreamTimeoutOptions,
  send: (frame: ResponsesSseFrame | string) => Promise<void>,
): Promise<void> {
  const response = await upstream.postStream(
    "responses",
    encodeResponsesRequest(request, {
      store: false,
      replaySourceExtensions: true,
      promptCache: { kind: "none" },
    }),
    apiKey,
    signal,
  );
  if (!response.body) {
    throw new Error("Upstream Responses stream has no body");
  }

  const decoder = new ResponsesStreamDecoder(argumentLimits, streamOutputLimits);
  const encoder = new ResponsesStreamEncoder(argumentLimits, streamOutputLimits);
  for await (const frame of parseSseStream(response.body, timeoutOptions, signal, {
    maxFrameBytes: timeoutOptions.maxFrameBytes,
  })) {
    for (const event of decoder.decode(frame)) {
      for (const encoded of encoder.encode(event)) {
        await send(encoded);
      }
    }
  }
  decoder.finish();
  await send("[DONE]");
}

async function streamAnthropicResponse(
  upstream: UpstreamClient,
  request: CanonicalRequest,
  apiKey: string,
  signal: AbortSignal,
  promptCacheSidecar: PromptCacheSidecar,
  promptCacheEnabled: boolean,
  promptCacheCapabilities: PromptCacheCapabilities,
  encoderOptions: AnthropicStreamEncoderOptions,
  timeoutOptions: StreamTimeoutOptions,
  pingIntervalMs: number,
  send: (frame: AnthropicSseFrame) => Promise<void>,
): Promise<void> {
  let response: Response;
  let decoder: ResponsesStreamDecoder | ChatStreamDecoder;
  try {
    preparePromptCacheAttempt({
      request,
      sidecar: promptCacheSidecar,
      enabled: promptCacheEnabled,
      operation: "completion",
      capability: promptCacheCapabilities.responses,
    });
    response = await upstream.postStream(
      "responses",
      encodeResponsesRequest(request, { store: false, promptCache: { kind: "none" } }),
      apiKey,
      signal,
    );
    decoder = new ResponsesStreamDecoder(
      encoderOptions.toolArgumentLimits,
      encoderOptions.outputLimits,
    );
  } catch (error) {
    if (
      !(error instanceof UpstreamHttpError) ||
      !shouldFallbackToChat({
        failure: {
          status: error.status,
          ...(error.code === undefined ? {} : { code: error.code }),
        },
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      })
    ) {
      throw error;
    }
    preparePromptCacheAttempt({
      request,
      sidecar: promptCacheSidecar,
      enabled: promptCacheEnabled,
      operation: "completion",
      capability: promptCacheCapabilities.chatCompletions,
    });
    response = await upstream.postStream(
      "chat/completions",
      encodeChatRequest(request),
      apiKey,
      signal,
    );
    decoder = new ChatStreamDecoder(encoderOptions.toolArgumentLimits, encoderOptions.outputLimits);
  }

  if (!response.body) {
    throw new Error("Upstream completion stream has no body");
  }

  const webSearchRequests = readWebSearchUsageHeader(response);
  const webSearchExecutions = decodeWebSearchExecutionsHeader(
    response.headers.get("x-ai-hub-web-search-trace"),
  );
  const encoder = new AnthropicStreamEncoder({ ...encoderOptions, webSearchExecutions });
  const frames = parseSseStream(response.body, timeoutOptions, signal, {
    maxFrameBytes: timeoutOptions.maxFrameBytes,
  })[Symbol.asyncIterator]();
  const pinged = new PingedIterator(frames, pingIntervalMs);
  try {
    while (true) {
      const next = await pinged.next();
      if (next.type === "done") {
        break;
      }
      if (next.type === "ping") {
        await send({ event: "ping", data: { type: "ping" } });
        pinged.markClientWrite();
        continue;
      }
      for (const event of decoder.decode(next.value)) {
        for (const encoded of encoder.encode(addWebSearchUsageToEvent(event, webSearchRequests))) {
          await send(encoded);
          pinged.markClientWrite();
        }
      }
    }
    decoder.finish();
  } finally {
    pinged.close();
  }
}

async function requestAnthropicCompletion(
  upstream: UpstreamClient,
  request: CanonicalRequest,
  apiKey: string,
  signal: AbortSignal,
  promptCacheSidecar: PromptCacheSidecar,
  promptCacheEnabled: boolean,
  promptCacheCapabilities: PromptCacheCapabilities,
): Promise<AnthropicCompletionResult> {
  try {
    preparePromptCacheAttempt({
      request,
      sidecar: promptCacheSidecar,
      enabled: promptCacheEnabled,
      operation: "completion",
      capability: promptCacheCapabilities.responses,
    });
    const response = await upstream.postJson(
      "responses",
      encodeResponsesRequest(request, { store: false, promptCache: { kind: "none" } }),
      apiKey,
      signal,
    );
    return {
      response: addWebSearchUsage(decodeResponsesResponse(response), response),
      webSearchExecutions: getWebSearchExecutions(response),
    };
  } catch (error) {
    if (
      !(error instanceof UpstreamHttpError) ||
      !shouldFallbackToChat({
        failure: {
          status: error.status,
          ...(error.code === undefined ? {} : { code: error.code }),
        },
        hasUpstreamSemanticEvent: false,
        hasWrittenClientBytes: false,
      })
    ) {
      throw error;
    }
  }

  preparePromptCacheAttempt({
    request,
    sidecar: promptCacheSidecar,
    enabled: promptCacheEnabled,
    operation: "completion",
    capability: promptCacheCapabilities.chatCompletions,
  });
  const response = await upstream.postJson(
    "chat/completions",
    encodeChatRequest(request),
    apiKey,
    signal,
  );
  return {
    response: addWebSearchUsage(decodeChatResponse(response), response),
    webSearchExecutions: getWebSearchExecutions(response),
  };
}

function normalizeResponseToolArguments(
  response: CanonicalResponse,
  enabled: boolean,
): CanonicalResponse {
  if (!enabled) {
    return response;
  }
  return {
    ...response,
    content: response.content.map((content) =>
      content.type === "function_call"
        ? {
            ...content,
            arguments: normalizeReadToolArguments(content.name, content.arguments, true).json,
          }
        : content,
    ),
  };
}
