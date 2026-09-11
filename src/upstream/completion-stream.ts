import type { CanonicalEvent } from "../core/events.js";
import type { WebSearchTool } from "../core/ir.js";
import { encodeChatRequest } from "../protocols/openai-chat/encode.js";
import { ChatStreamDecoder } from "../protocols/openai-chat/stream-decode.js";
import { decodeResponsesResponse } from "../protocols/openai-responses/decode.js";
import { ResponsesStreamDecoder } from "../protocols/openai-responses/stream-decode.js";
import { ResponsesStreamEncoder } from "../protocols/openai-responses/stream-encode.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../providers/web-search/internal.js";
import type { WebSearchProvider } from "../providers/web-search/types.js";
import { DEFAULT_STREAM_OUTPUT_LIMITS, type StreamOutputLimits } from "../stream/output-limits.js";
import {
  parseSseStream,
  SseStreamTimeoutError,
  type SseStreamTimeoutOptions,
} from "../stream/sse-parser.js";
import {
  DEFAULT_TOOL_ARGUMENT_LIMITS,
  type ToolArgumentLimits,
  ToolArgumentStreamLimiter,
} from "../stream/tool-argument-limits.js";
import { type CompletionPath, replaceCompletionUsage } from "./usage.js";
import { forceNonStreamingBody, hasInternalWebSearchTool } from "./web-search-loop.js";
import { WebSearchSession } from "./web-search-session.js";

export interface CompletionStreamOptions {
  preserveChatWireMetadata?: boolean;
  validateChatToolArguments?: boolean;
  allowIncompleteToolArguments?: boolean;
  webSearch?: WebSearchTool;
  argumentLimits?: ToolArgumentLimits;
  outputLimits?: StreamOutputLimits;
  timeouts?: SseStreamTimeoutOptions;
  maxFrameBytes?: number;
}

type PostStream = (body: unknown, signal: AbortSignal) => Promise<Response>;

async function* decodeRound(
  path: CompletionPath,
  body: unknown,
  post: PostStream,
  signal: AbortSignal,
  options: CompletionStreamOptions,
): AsyncGenerator<CanonicalEvent> {
  const controller = new AbortController();
  const roundSignal = AbortSignal.any([signal, controller.signal]);
  const startedAt = performance.now();
  const firstByteMs = options.timeouts?.firstByteTimeoutMs ?? 60_000;
  const timer = setTimeout(() => {
    const error = new SseStreamTimeoutError("first-byte");
    controller.abort(error);
    options.timeouts?.onTimeout?.(error);
  }, firstByteMs);
  timer.unref();
  try {
    const response = await post(body, roundSignal);
    clearTimeout(timer);
    if (!response.body) throw new Error("Upstream stream has no body");
    const decoder =
      path === "responses"
        ? new ResponsesStreamDecoder(options.argumentLimits, options.outputLimits, {
            allowIncompleteToolArguments: options.allowIncompleteToolArguments ?? false,
          })
        : new ChatStreamDecoder(options.argumentLimits, options.outputLimits, {
            preserveWireMetadata: options.preserveChatWireMetadata ?? false,
            validateToolArguments: options.validateChatToolArguments ?? true,
          });
    for await (const frame of parseSseStream(
      response.body,
      {
        firstByteTimeoutMs: Math.max(1, firstByteMs - (performance.now() - startedAt)),
        idleTimeoutMs: options.timeouts?.idleTimeoutMs ?? 120_000,
        onTimeout: (error) => {
          controller.abort(error);
          options.timeouts?.onTimeout?.(error);
        },
      },
      roundSignal,
      { maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024 },
    )) {
      roundSignal.throwIfAborted();
      yield* decoder.decode(frame);
    }
    roundSignal.throwIfAborted();
    decoder.finish();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Collect only the bounded item state needed to send tool results back to the model.
// Visible events are yielded immediately, before the round or subsequent searches finish.
export async function* streamCompletion(
  path: CompletionPath,
  body: unknown,
  post: PostStream,
  provider: WebSearchProvider,
  signal: AbortSignal,
  options: CompletionStreamOptions,
): AsyncGenerator<CanonicalEvent> {
  if (!hasInternalWebSearchTool(path, body)) {
    yield* decodeRound(path, body, post, signal, options);
    return;
  }
  const outputLimits = options.outputLimits ?? DEFAULT_STREAM_OUTPUT_LIMITS;
  const argumentLimits = options.argumentLimits ?? DEFAULT_TOOL_ARGUMENT_LIMITS;
  const session = new WebSearchSession(
    path,
    provider,
    outputLimits.perStreamBytes,
    options.webSearch,
  );
  let current = session.prepare(forceNonStreamingBody(path, body));
  let started = false;
  let nextIndex = 0;
  let nextCallIndex = 0;
  const argumentsBudget = new ToolArgumentStreamLimiter(argumentLimits);
  for (let round = 0; round < 8; round++) {
    const collector = new ResponsesStreamEncoder(argumentLimits, outputLimits);
    const visible = new Map<number, number>();
    const callIndices = new Map<number, number>();
    let completion: Extract<CanonicalEvent, { type: "response_complete" }> | undefined;
    let responseBody: Record<string, unknown> | undefined;
    for await (const event of decodeRound(
      path,
      {
        ...current,
        stream: true,
        ...(path === "chat/completions" ? { stream_options: { include_usage: true } } : {}),
      },
      post,
      signal,
      options,
    )) {
      if (event.type === "content_start" && event.content.type === "function_call") {
        const callIndex = nextCallIndex++;
        callIndices.set(event.index, callIndex);
        argumentsBudget.add(callIndex, event.content.arguments);
      } else if (event.type === "function_arguments_delta") {
        const callIndex = callIndices.get(event.index);
        if (callIndex !== undefined) argumentsBudget.add(callIndex, event.delta);
      } else if (event.type === "content_stop") {
        const callIndex = callIndices.get(event.index);
        if (callIndex !== undefined) argumentsBudget.finish(callIndex);
      }
      const collected =
        event.type === "content_start" && event.itemId === undefined
          ? { ...event, itemId: `gateway_item_${round}_${event.index}` }
          : event;
      for (const frame of collector.encode(collected)) {
        if (event.type === "response_complete")
          responseBody = frame.data.response as Record<string, unknown>;
      }
      if (event.type === "response_start") {
        if (!started) {
          started = true;
          yield event;
        }
      } else if (event.type === "response_complete") {
        completion = event;
      } else if (event.type === "content_start") {
        if (
          event.content.type === "function_call" &&
          event.content.name === INTERNAL_WEB_SEARCH_TOOL_NAME
        )
          continue;
        const index = nextIndex++;
        visible.set(event.index, index);
        yield { ...event, index };
      } else if ("index" in event) {
        const index = visible.get(event.index);
        if (index !== undefined) yield { ...event, index };
      } else {
        yield event;
        if (event.type === "response_error") return;
      }
    }
    if (!completion || !responseBody) throw new Error("Upstream stream did not complete");
    if (path === "chat/completions") {
      const canonical = decodeResponsesResponse(responseBody);
      const request = encodeChatRequest({
        source: "openai-chat",
        model: canonical.model,
        stream: false,
        tools: [],
        messages: [{ role: "assistant", content: canonical.content }],
      });
      responseBody = replaceCompletionUsage(
        path,
        {
          id: canonical.id,
          model: canonical.model,
          choices: [{ message: request.messages[0] }],
        },
        canonical.usage,
      ) as Record<string, unknown>;
    }
    const next = yield* session.advance(current, responseBody, signal);
    if (!next) {
      yield {
        ...completion,
        usage: {
          ...session.usage,
          ...(session.executions.length === 0
            ? {}
            : { webSearchRequests: session.executions.length }),
        },
      };
      return;
    }
    current = next;
  }
  throw new Error("Web Search tool loop exceeded the maximum number of rounds");
}
