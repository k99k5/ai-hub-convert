import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { SSEPluginOptions } from "@fastify/sse";
import type { FastifyPluginAsync } from "fastify";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config.js";
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
  OpenAIChatBodySchema,
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
import type { WebSearchProvider } from "./providers/web-search/types.js";
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
import { decodeChatRequest } from "./protocols/openai-chat/request-decode.js";
import { encodeChatResponse } from "./protocols/openai-chat/response-encode.js";
import { ChatStreamEncoder } from "./protocols/openai-chat/stream-encode.js";
import { decodeResponsesRequest } from "./protocols/openai-responses/request-decode.js";
import { responsesInputDiagnostic } from "./protocols/openai-responses/diagnostics.js";
import { encodeResponsesResponse } from "./protocols/openai-responses/response-encode.js";
import {
  addResponsesWebSearch,
  includeWebSearchSources,
} from "./protocols/openai-responses/web-search.js";
import { decodeResponsesResponse } from "./protocols/openai-responses/decode.js";
import { encodeResponsesRequest } from "./protocols/openai-responses/encode.js";
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
import { ToolArgumentLimitError, type ToolArgumentLimits } from "./stream/tool-argument-limits.js";
import { UpstreamClient, UpstreamHttpError } from "./upstream/client.js";
import { shouldFallbackToChat } from "./upstream/routing.js";
import {
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
  webSearchProvider?: WebSearchProvider;
}

interface AnthropicMessageBody {
  system?: string | Array<{ type?: string; text?: string }>;
}

type RouteProtocol = "anthropic" | "openai-responses" | "openai-chat";

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
  if (url === "/v1/chat/completions") return "openai-chat";
  return url === "/v1/responses" ? "openai-responses" : "anthropic";
}

function isBoundaryError(error: unknown): error is FastifyBoundaryError {
  return error instanceof Error;
}

function isProtocolAdapterError(error: unknown): boolean {
  return error instanceof OpenAIAdapterError || error instanceof ChatAdapterError;
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

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config } = options;
  const upstream = new UpstreamClient({
    baseUrl: config.upstream.baseUrl,
    timeoutMs: config.upstream.timeoutMs,
    jsonBodyLimitBytes: config.upstream.jsonBodyLimitBytes,
    errorBodyLimitBytes: config.upstream.errorBodyLimitBytes,
    ...(options.upstreamFetch === undefined ? {} : { fetch: options.upstreamFetch }),
    ...(options.webSearchProvider === undefined
      ? {}
      : { webSearchProvider: options.webSearchProvider }),
  });
  const activeStreams = new ActiveStreamRegistry();
  const webSearchProviders = createDefaultWebSearchRegistry(options.webSearchProvider);
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
          const abortScope = createRequestAbortScope(
            request.raw,
            reply.raw,
            config.upstream.timeoutMs,
          );
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

        const abortScope = createRequestAbortScope(
          request.raw,
          reply.raw,
          config.upstream.timeoutMs,
        );
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

        const abortScope = createRequestAbortScope(
          request.raw,
          reply.raw,
          config.upstream.timeoutMs,
        );
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
      "/v1/chat/completions",
      {
        schema: { body: OpenAIChatBodySchema },
        sse: { kind: "manual", heartbeat: false },
      },
      async (request, reply) => {
        let apiKey: string;
        let canonicalRequest: CanonicalRequest;
        try {
          apiKey = extractResponsesApiKey(request.headers);
          canonicalRequest = decodeChatRequest(request.body);
        } catch (error) {
          if (error instanceof AuthenticationError) {
            return reply.code(401).send({
              error: {
                type: "authentication_error",
                code: "invalid_api_key",
                message: "需要有效的 Bearer 凭据",
              },
              request_id: request.id,
            });
          }
          if (error instanceof ChatAdapterError) {
            return sendOpenAIRequestError(reply, 400, "invalid_request", error.message);
          }
          throw error;
        }

        const abortScope = createRequestAbortScope(
          request.raw,
          reply.raw,
          config.upstream.timeoutMs,
        );
        if (!canonicalRequest.stream) {
          try {
            const response = await upstream.postJson(
              "chat/completions",
              encodeChatRequest(canonicalRequest),
              apiKey,
              abortScope.signal,
            );
            return reply.send(
              encodeChatResponse(
                decodeChatResponse(response, {
                  preserveWireMetadata: true,
                  validateToolArguments: false,
                }),
              ),
            );
          } catch (error) {
            const mapped = mapUpstreamError("openai-chat", error, request.id);
            return reply.code(mapped.status).send(mapped.body);
          } finally {
            abortScope.dispose();
          }
        }

        const removeActiveStream = activeStreams.add(abortScope);
        const clientStream = new ClientSseSender(reply);
        reply.sse.onClose(() => abortScope.abort(new Error("客户端已断开连接")));
        const streamOptions = canonicalRequest.extensions?.request?.stream_options;
        const includeUsage =
          typeof streamOptions === "object" &&
          streamOptions !== null &&
          "include_usage" in streamOptions &&
          streamOptions.include_usage === true;
        const encoder = new ChatStreamEncoder({ includeUsage });
        let completed = false;
        try {
          for await (const event of upstream.streamCompletion(
            "chat/completions",
            encodeChatRequest(canonicalRequest),
            apiKey,
            abortScope.signal,
            {
              preserveChatWireMetadata: true,
              validateChatToolArguments: false,
              argumentLimits: toolArgumentLimits(config),
              outputLimits: outputLimits(config),
              timeouts: {
                firstByteTimeoutMs: config.upstream.firstByteTimeoutMs,
                idleTimeoutMs: config.upstream.streamIdleTimeoutMs,
                onTimeout: (error) => abortScope.abort(error),
              },
              maxFrameBytes: config.upstream.sseFrameLimitBytes,
            },
          )) {
            for (const frame of encoder.encode(event)) {
              // 等到上游流完整校验结束再发送成功标记，避免尾部错误被客户端忽略。
              if (frame.data === "[DONE]") completed = true;
              else await clientStream.send(frame);
            }
            if (event.type === "response_error") return;
          }
          if (completed) await clientStream.send("[DONE]");
          return;
        } catch (error) {
          abortScope.abort(error);
          if (!reply.raw.headersSent) {
            const mapped = mapUpstreamError("openai-chat", error, request.id);
            return reply.code(mapped.status).send(mapped.body);
          }
          await clientStream.sendError({
            data: {
              error: {
                type: "server_error",
                code:
                  error instanceof ToolArgumentLimitError || error instanceof StreamOutputLimitError
                    ? error.code
                    : "upstream_stream_error",
                message: "上游流式响应失败",
              },
            },
          });
          return;
        } finally {
          removeActiveStream();
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
            request.log.warn(
              { request_id: request.id, ...responsesInputDiagnostic(request.body, error) },
              "[DEBUG-responses-input-v1] Responses 输入校验失败",
            );
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
          const abortScope = createRequestAbortScope(
            request.raw,
            reply.raw,
            config.upstream.timeoutMs,
          );
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

        const abortScope = createRequestAbortScope(
          request.raw,
          reply.raw,
          config.upstream.timeoutMs,
        );
        try {
          const upstreamResponse = await upstream.postJson(
            "responses",
            encodeResponsesRequest(canonicalRequest, {
              store: false,
              replaySourceExtensions: true,
              promptCache: GENERIC_PROMPT_CACHE_CAPABILITIES.responses,
            }),
            apiKey,
            abortScope.signal,
            webSearchOptions(canonicalRequest).webSearch,
          );
          return reply.send(
            addResponsesWebSearch(
              encodeResponsesResponse(
                decodeResponsesResponse(upstreamResponse, { preserveWireMetadata: true }),
              ),
              getWebSearchExecutions(upstreamResponse),
              includeWebSearchSources(canonicalRequest),
              outputLimits(config),
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
  const encoder = new ResponsesStreamEncoder(argumentLimits, streamOutputLimits, {
    includeWebSearchSources: includeWebSearchSources(request),
  });
  for await (const event of upstream.streamCompletion(
    "responses",
    encodeResponsesRequest(request, {
      store: false,
      replaySourceExtensions: true,
      promptCache: GENERIC_PROMPT_CACHE_CAPABILITIES.responses,
    }),
    apiKey,
    signal,
    {
      argumentLimits,
      outputLimits: streamOutputLimits,
      timeouts: timeoutOptions,
      maxFrameBytes: timeoutOptions.maxFrameBytes,
      ...webSearchOptions(request),
    },
  )) {
    for (const frame of encoder.encode(event)) await send(frame);
  }
  await send("[DONE]");
}

function webSearchOptions(request: CanonicalRequest) {
  const webSearch = request.tools.find((tool) => tool.type === "web_search");
  return webSearch === undefined ? {} : { webSearch };
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
  const options = {
    ...(encoderOptions.toolArgumentLimits === undefined
      ? {}
      : { argumentLimits: encoderOptions.toolArgumentLimits }),
    ...(encoderOptions.outputLimits === undefined
      ? {}
      : { outputLimits: encoderOptions.outputLimits }),
    timeouts: timeoutOptions,
    maxFrameBytes: timeoutOptions.maxFrameBytes,
    ...webSearchOptions(request),
  };
  const events = (async function* () {
    preparePromptCacheAttempt({
      request,
      sidecar: promptCacheSidecar,
      enabled: promptCacheEnabled,
      operation: "completion",
      capability: promptCacheCapabilities.responses,
    });
    try {
      yield* upstream.streamCompletion(
        "responses",
        encodeResponsesRequest(request, {
          store: false,
          promptCache: promptCacheCapabilities.responses,
        }),
        apiKey,
        signal,
        options,
      );
      return;
    } catch (error) {
      if (
        !(error instanceof UpstreamHttpError) ||
        !shouldFallbackToChat({
          failure: {
            status: error.status,
            ...(error.code === undefined ? {} : { code: error.code }),
          },
          hasUpstreamSemanticEvent: error.hasUpstreamSemanticEvent,
          hasWrittenClientBytes: error.hasUpstreamSemanticEvent,
        })
      )
        throw error;
    }
    preparePromptCacheAttempt({
      request,
      sidecar: promptCacheSidecar,
      enabled: promptCacheEnabled,
      operation: "completion",
      capability: promptCacheCapabilities.chatCompletions,
    });
    yield* upstream.streamCompletion(
      "chat/completions",
      encodeChatRequest(request),
      apiKey,
      signal,
      options,
    );
  })();
  const encoder = new AnthropicStreamEncoder(encoderOptions);
  const pinged = new PingedIterator(events, pingIntervalMs);
  try {
    while (true) {
      const next = await pinged.next();
      if (next.type === "done") break;
      if (next.type === "ping") {
        await send({ event: "ping", data: { type: "ping" } });
        pinged.markClientWrite();
        continue;
      }
      for (const frame of encoder.encode(next.value)) {
        await send(frame);
        pinged.markClientWrite();
      }
    }
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
      encodeResponsesRequest(request, {
        store: false,
        promptCache: promptCacheCapabilities.responses,
      }),
      apiKey,
      signal,
      webSearchOptions(request).webSearch,
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
        hasUpstreamSemanticEvent: error.hasUpstreamSemanticEvent,
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
    webSearchOptions(request).webSearch,
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
