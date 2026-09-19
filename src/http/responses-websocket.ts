import { randomUUID } from "node:crypto";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { WebSocket, type RawData } from "ws";
import type { AppConfig } from "../config.js";
import type { PreparedResponsesRequest } from "../protocols/openai-responses/prepare.js";
import type { ResponsesSseFrame } from "../protocols/openai-responses/stream-encode.js";
import { OpenAIAdapterError } from "../protocols/openai-responses/types.js";
import { OpenAIAdapterError as ChatAdapterError } from "../protocols/openai-chat/types.js";
import { WebSearchUnsupportedError } from "../providers/web-search/unsupported.js";
import type { ActiveStreamRegistry } from "../stream/active-streams.js";
import { StreamOutputLimitError } from "../stream/output-limits.js";
import { ToolArgumentLimitError } from "../stream/tool-argument-limits.js";
import { AuthenticationError, extractResponsesApiKey } from "./auth.js";
import { mapUpstreamError } from "./upstream-errors.js";
import type { ConversationTurn } from "../policies/conversation-store.js";
import {
  conversationItems,
  withConversationFrame,
} from "../protocols/openai-responses/conversation.js";

type Wire = Record<string, unknown>;
interface AbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
}

interface WebSocketOptions {
  config: AppConfig;
  activeStreams: ActiveStreamRegistry;
  prepare(value: unknown, apiKey: string): PreparedResponsesRequest;
  run(
    prepared: PreparedResponsesRequest,
    apiKey: string,
    scope: AbortScope,
    send: (frame: ResponsesSseFrame | string) => Promise<void>,
  ): Promise<void>;
}

class WebSocketRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface History {
  id: string;
  model: string;
  json: string;
  bytes: number;
}

export async function registerResponsesWebSocket(
  api: FastifyInstance,
  options: WebSocketOptions,
): Promise<void> {
  await api.register(fastifyWebsocket, {
    options: { maxPayload: options.config.server.bodyLimitBytes, perMessageDeflate: false },
    errorHandler: (_error, socket) => {
      // Protocol errors may already be closing the socket (for example, close code 1009).
      if (socket.readyState === WebSocket.OPEN) socket.terminate();
    },
  });
  api.route({
    method: "GET",
    url: "/v1/responses",
    exposeHeadRoute: false,
    onRequest: async (request, reply) => {
      try {
        extractResponsesApiKey(request.headers);
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
        return reply.code(401).send({
          error: {
            type: "authentication_error",
            code: "invalid_api_key",
            message: error.message,
          },
          request_id: request.id,
        });
      }
    },
    handler: async (_request, reply) =>
      reply
        .code(426)
        .header("upgrade", "websocket")
        .send({
          error: {
            type: "invalid_request_error",
            code: "websocket_required",
            message: "Use a WebSocket connection or POST /v1/responses",
          },
        }),
    wsHandler: (socket, request) => {
      new ResponsesWebSocketSession(
        socket,
        extractResponsesApiKey(request.headers),
        request.id,
        options,
      );
    },
  });
}

class ResponsesWebSocketSession {
  readonly #controller = new AbortController();
  readonly #lanes = new Map<string, Promise<void>>();
  readonly #namedStreams = new Set<string>();
  readonly #history = new Map<string, History>();
  readonly #removeActive: () => void;
  readonly #expiry: ReturnType<typeof setTimeout>;
  readonly #heartbeat: ReturnType<typeof setInterval> | undefined;
  #historyBytes = 0;
  #pendingBytes = 0;
  #pendingRequests = 0;
  #alive = true;

  constructor(
    readonly socket: WebSocket,
    readonly apiKey: string,
    readonly requestId: string,
    readonly options: WebSocketOptions,
  ) {
    this.#removeActive = options.activeStreams.add(this);
    this.#expiry = setTimeout(() => {
      void this.#sendError(
        new WebSocketRequestError(
          "websocket_connection_limit_reached",
          "WebSocket connection lifetime reached; reconnect and replay the full input context",
        ),
      ).finally(() => this.abort());
    }, options.config.websocket.maxConnectionMs);
    this.#expiry.unref();
    const interval = options.config.websocket.pingIntervalMs;
    if (interval > 0) {
      this.#heartbeat = setInterval(() => {
        if (!this.#alive) return this.abort();
        this.#alive = false;
        if (socket.readyState === WebSocket.OPEN) {
          socket.ping(undefined, false, (error) => {
            if (error) this.abort(error);
          });
        }
      }, interval);
      this.#heartbeat.unref();
    }
    socket.on("pong", () => {
      this.#alive = true;
    });
    socket.on("close", () => this.abort());
    socket.on("error", () => this.abort());
    // Attach synchronously so frames sent immediately after the handshake cannot be lost.
    socket.on("message", (data, binary) => this.#receive(data, binary));
  }

  abort(reason: unknown = new Error("WebSocket connection closed")): void {
    if (this.#controller.signal.aborted) return;
    this.#controller.abort(reason);
    clearTimeout(this.#expiry);
    clearInterval(this.#heartbeat);
    this.#history.clear();
    this.#historyBytes = 0;
    this.#removeActive();
    // Termination also releases blocked writes and does not wait for an unresponsive peer.
    if (this.socket.readyState === WebSocket.OPEN) this.socket.terminate();
  }

  #receive(data: RawData, binary: boolean): void {
    if (this.#controller.signal.aborted) return;
    let streamId: string | undefined;
    try {
      if (binary) throw new WebSocketRequestError("invalid_request", "Use JSON text messages");
      let event: unknown;
      const text = data.toString();
      try {
        event = JSON.parse(text);
      } catch {
        throw new WebSocketRequestError("invalid_json", "Invalid JSON message");
      }
      if (!isRecord(event)) {
        throw new WebSocketRequestError("invalid_request", "Expected a JSON object");
      }
      if (event.stream_id !== undefined) {
        if (
          typeof event.stream_id !== "string" ||
          !/^[A-Za-z0-9_.-]{1,256}$/.test(event.stream_id)
        ) {
          throw new WebSocketRequestError("invalid_stream_id", "Invalid stream_id", "stream_id");
        }
        streamId = event.stream_id;
      }
      if (event.type !== "response.create") {
        throw new WebSocketRequestError(
          "invalid_request",
          "Only response.create events are supported",
          "type",
        );
      }
      if (streamId !== undefined && !this.#namedStreams.has(streamId)) {
        if (this.#namedStreams.size >= 32) {
          throw new WebSocketRequestError(
            "websocket_stream_limit_reached",
            "Reuse an existing stream_id or open a new connection (32 named streams maximum)",
            "stream_id",
          );
        }
        this.#namedStreams.add(streamId);
      }
      const bytes = Buffer.byteLength(text);
      if (
        this.#pendingRequests >= this.options.config.websocket.maxPendingRequests ||
        this.#pendingBytes + bytes > this.options.config.server.bodyLimitBytes
      ) {
        throw new WebSocketRequestError(
          "websocket_queue_full",
          "Too many pending requests; wait for a response to finish",
          null,
          429,
        );
      }
      this.#pendingRequests++;
      this.#pendingBytes += bytes;
      const lane = streamId ?? "";
      const prior = this.#lanes.get(lane) ?? Promise.resolve();
      const task = prior
        .then(() => this.#run(event as Wire, streamId))
        .catch((error: unknown) => this.abort(error))
        .finally(() => {
          this.#pendingRequests--;
          this.#pendingBytes -= bytes;
          if (this.#lanes.get(lane) === task) this.#lanes.delete(lane);
        });
      this.#lanes.set(lane, task);
    } catch (error) {
      void this.#sendError(error, streamId);
    }
  }

  async #run(event: Wire, streamId: string | undefined): Promise<void> {
    if (this.#controller.signal.aborted) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Response timed out")),
      this.options.config.upstream.timeoutMs,
    );
    timer.unref();
    const signal = AbortSignal.any([this.#controller.signal, controller.signal]);
    const lane = streamId ?? "";
    let completedId: string | undefined;
    let conversation: ConversationTurn | undefined;
    try {
      const { type, stream_id, stream, generate, previous_response_id, ...body } = event;
      if (generate !== undefined && typeof generate !== "boolean") {
        throw new WebSocketRequestError(
          "invalid_request",
          "generate must be a boolean",
          "generate",
        );
      }
      // Codex reuses its streaming Responses request for WS, including prewarm.
      // The transport always streams; an explicit true is a compatible no-op.
      if (stream !== undefined && stream !== true) {
        throw new WebSocketRequestError(
          "invalid_request",
          "stream must be true or omitted in WebSocket mode",
          "stream",
        );
      }
      if ("background" in body) {
        throw new WebSocketRequestError(
          "invalid_request",
          "background is not used in WebSocket mode",
          "background",
        );
      }
      if (previous_response_id !== undefined && previous_response_id !== null) {
        if (body.conversation != null) {
          throw new WebSocketRequestError(
            "invalid_request",
            "conversation and previous_response_id cannot be used together",
            "conversation",
          );
        }
        if (typeof previous_response_id !== "string" || previous_response_id.length === 0) {
          throw new WebSocketRequestError(
            "invalid_request",
            "Invalid previous_response_id",
            "previous_response_id",
          );
        }
        const parent = [...this.#history.values()].find(
          (entry) => entry.id === previous_response_id && entry.model === body.model,
        );
        if (!parent) {
          throw new WebSocketRequestError(
            "previous_response_not_found",
            "Previous response is unavailable on this connection; send the full input context",
            "previous_response_id",
          );
        }
        const input =
          typeof body.input === "string"
            ? [{ role: "user", content: body.input }]
            : body.input == null
              ? []
              : body.input;
        if (!Array.isArray(input)) {
          throw new WebSocketRequestError("invalid_request", "Invalid input", "input");
        }
        body.input = [...(JSON.parse(parent.json) as unknown[]), ...input];
      }
      if (Buffer.byteLength(JSON.stringify(body)) > this.options.config.server.bodyLimitBytes) {
        throw new WebSocketRequestError(
          "request_too_large",
          "Expanded input exceeds BODY_LIMIT_BYTES",
          "input",
          413,
        );
      }
      const prepared = this.options.prepare({ ...body, stream: true }, this.apiKey);
      conversation = prepared.conversation;
      // Continuation belongs to this connection; never rely on upstream persistence.
      prepared.body = { ...(prepared.body as Wire), store: false };
      const send = async (frame: ResponsesSseFrame | string) => {
        frame = withConversationFrame(frame, conversation?.id);
        // WS carries one JSON event per message, without SSE framing or the [DONE] sentinel.
        if (typeof frame === "string") return;
        if (frame.event === "error") {
          this.#forget(lane);
          await this.#send(
            {
              type: "error",
              status: 500,
              error: {
                type: "server_error",
                code: frame.data.code,
                message: frame.data.message,
                param: null,
              },
              ...(streamId === undefined ? {} : { stream_id: streamId }),
            },
            signal,
          );
          return;
        }
        if (frame.event === "response.completed") {
          const response = frame.data.response as Wire;
          conversation?.commit(conversationItems(response.output as unknown[], true));
          completedId = response.id as string;
          this.#remember(lane, completedId, prepared.request.model, [
            ...prepared.input,
            ...(response.output as unknown[]),
          ]);
        }
        await this.#send(
          {
            ...frame.data,
            ...(streamId === undefined ? {} : { stream_id: streamId }),
          },
          signal,
        );
      };
      if (generate === false) {
        const response = {
          id: `resp_${randomUUID()}`,
          object: "response",
          model: prepared.request.model,
          status: "in_progress",
          output: [],
          error: null,
          incomplete_details: null,
          usage: null,
        };
        for (const [sequence, status] of ["created", "in_progress", "completed"].entries()) {
          await send({
            event: `response.${status}`,
            data: {
              type: `response.${status}`,
              sequence_number: sequence,
              response: {
                ...response,
                status: status === "completed" ? "completed" : "in_progress",
              },
            },
          });
        }
      } else {
        await this.options.run(
          prepared,
          this.apiKey,
          {
            signal,
            abort: (reason) => controller.abort(reason),
          },
          send,
        );
      }
    } catch (error) {
      controller.abort(error);
      // A failed continuation invalidates its own lane, but not a cross-lane fork's parent.
      const cachedId = this.#history.get(lane)?.id;
      if (cachedId === event.previous_response_id || (completedId && cachedId === completedId)) {
        this.#forget(lane);
      }
      await this.#sendError(error, streamId);
    } finally {
      clearTimeout(timer);
      conversation?.release();
    }
  }

  #forget(lane: string): void {
    const old = this.#history.get(lane);
    if (old) this.#historyBytes -= old.bytes;
    this.#history.delete(lane);
  }

  #remember(lane: string, id: string, model: string, input: unknown[]): void {
    this.#forget(lane);
    const json = JSON.stringify(input);
    const bytes = Buffer.byteLength(json);
    const limit = this.options.config.websocket.historyLimitBytes;
    if (bytes > limit) return;
    while (this.#historyBytes + bytes > limit) {
      const oldest = this.#history.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
    this.#history.set(lane, { id, model, json, bytes });
    this.#historyBytes += bytes;
  }

  async #sendError(error: unknown, streamId?: string): Promise<void> {
    if (this.#controller.signal.aborted) return;
    let mapped = mapUpstreamError("openai-responses", error, this.requestId);
    if (error instanceof WebSocketRequestError) {
      mapped = {
        status: error.status,
        body: {
          error: {
            type: error.status === 429 ? "rate_limit_error" : "invalid_request_error",
            code: error.code,
            message: error.message,
            param: error.param,
          },
        },
      };
    } else if (error instanceof OpenAIAdapterError || error instanceof ChatAdapterError) {
      mapped = {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code:
              error.code === "REFERENCE_CACHE_MISS" ? "reference_cache_miss" : "invalid_request",
            message: error.message,
            param: null,
          },
        },
      };
    } else if (error instanceof WebSearchUnsupportedError) {
      mapped = {
        status: 501,
        body: {
          error: {
            type: "server_error",
            code: "web_search_unsupported",
            message: "Web Search is not supported",
          },
        },
      };
    } else if (error instanceof ToolArgumentLimitError || error instanceof StreamOutputLimitError) {
      mapped = {
        status: 500,
        body: {
          error: {
            type: "server_error",
            code: error.code,
            message: "The upstream stream exceeded its output limit",
          },
        },
      };
    }
    try {
      await this.#send({
        type: "error",
        status: mapped.status,
        ...mapped.body,
        ...(streamId === undefined ? {} : { stream_id: streamId }),
      });
    } catch (sendError) {
      this.abort(sendError);
    }
  }

  async #send(event: Wire, signal?: AbortSignal): Promise<void> {
    const sendSignal =
      signal ?? AbortSignal.any([this.#controller.signal, AbortSignal.timeout(5_000)]);
    sendSignal.throwIfAborted();
    const data = JSON.stringify(event);
    const maxBuffered =
      this.options.config.upstream.streamOutputLimitBytes +
      this.options.config.upstream.sseFrameLimitBytes;
    if (
      this.socket.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount + Buffer.byteLength(data) > maxBuffered
    ) {
      this.abort();
      throw new Error("WebSocket is closed or its send buffer is full");
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        sendSignal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        // A blocked client cannot receive an error; terminate to release pending callbacks.
        if (this.socket.bufferedAmount > 0) this.abort(sendSignal.reason);
        finish(sendSignal.reason);
      };
      sendSignal.addEventListener("abort", onAbort, { once: true });
      try {
        this.socket.send(data, (error) => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }
}

function isRecord(value: unknown): value is Wire {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
