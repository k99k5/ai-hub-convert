import type { CanonicalError, CanonicalEvent } from "../../core/events.js";
import type { FinishReason, Usage } from "../../core/ir.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../providers/web-search/internal.js";
import {
  DEFAULT_STREAM_OUTPUT_LIMITS,
  type StreamOutputLimits,
  StreamOutputLimiter,
} from "../../stream/output-limits.js";
import type { SseEvent } from "../../stream/sse-parser.js";
import {
  DEFAULT_TOOL_ARGUMENT_LIMITS,
  type ToolArgumentLimits,
  ToolArgumentStreamLimiter,
} from "../../stream/tool-argument-limits.js";

const OUTPUT_ITEM_OVERHEAD_BYTES = 256;

interface StreamIdentity {
  id: string;
  model: string;
  created?: number;
}

interface ToolState {
  canonicalIndex: number;
  id: string;
  name: string;
  arguments: string;
}

export class ChatStreamDecoder {
  #identity?: StreamIdentity;
  #terminal = false;
  #finishReason?: FinishReason;
  #wireFinishReason?: string;
  #usage: Usage = { inputTokens: 0, outputTokens: 0 };
  #nextContentIndex = 0;
  #reasoningIndex?: number;
  #textIndex?: number;
  #refusalIndex?: number;
  readonly #tools = new Map<number, ToolState>();
  readonly #openIndices = new Set<number>();
  readonly #argumentLimiter: ToolArgumentStreamLimiter;
  readonly #outputLimiter: StreamOutputLimiter;

  constructor(
    limits: ToolArgumentLimits = DEFAULT_TOOL_ARGUMENT_LIMITS,
    outputLimits: StreamOutputLimits = DEFAULT_STREAM_OUTPUT_LIMITS,
    private readonly options: {
      preserveWireMetadata?: boolean;
      validateToolArguments?: boolean;
      allowIncompleteToolArguments?: boolean;
    } = {},
  ) {
    this.#argumentLimiter = new ToolArgumentStreamLimiter(limits);
    this.#outputLimiter = new StreamOutputLimiter(outputLimits);
  }

  decode(frame: SseEvent): CanonicalEvent[] {
    if (this.#terminal) {
      throw new Error("Chat stream received data after DONE");
    }
    if (frame.data === "[DONE]") {
      return this.#decodeDone();
    }

    const payload = parsePayload(frame.data);
    if (isObject(payload.error)) {
      return this.#decodeError(payload.error);
    }

    const events = this.#start(payload);
    if (payload.usage !== undefined && payload.usage !== null) {
      this.#usage = decodeUsage(payload.usage);
    }

    // 纯 usage 帧可能省略 choices 或置为 null，语义上等同于空数组。
    const choices = payload.choices ?? [];
    if (!Array.isArray(choices)) {
      throw new Error("Chat stream choices must be an array");
    }
    if (choices.length === 0) {
      return events;
    }
    if (choices.length !== 1) {
      throw new Error("Chat stream must contain exactly one choice");
    }

    const choice = requireObject(choices[0], "choice");
    if (choice.index !== 0) {
      throw new Error("Chat stream choice index must be zero");
    }
    const delta = requireObject(choice.delta, "choice delta");
    this.#validateRole(delta.role);
    if (this.#finishReason !== undefined) {
      this.#validateTrailingChoice(choice, delta);
      return events;
    }
    events.push(...this.#decodeReasoning(delta));
    events.push(...this.#decodeText(delta.content));
    events.push(...this.#decodeRefusal(delta.refusal));
    events.push(...this.#decodeTools(delta.tool_calls));

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.#finishReason = decodeFinishReason(
        choice.finish_reason,
        this.#refusalIndex !== undefined,
      );
      this.#wireFinishReason = requireString(choice.finish_reason, "finish_reason");
      this.#validateToolArguments();
      for (const index of [...this.#openIndices].sort((left, right) => left - right)) {
        events.push({
          type: "content_stop",
          index,
          ...(this.#finishReason === "max_tokens" || this.#finishReason === "incomplete"
            ? { status: "incomplete" as const }
            : {}),
        });
      }
      this.#openIndices.clear();
    }

    return events;
  }

  // 返回上游 EOF 时需要补发的终态事件。[DONE] 只是哨兵：已收到 finish_reason 时
  // 正文、工具参数均已完整，按正常完成处理；未收到 finish_reason 才视为流被截断。
  finish(): CanonicalEvent[] {
    if (this.#terminal) {
      return [];
    }
    if (this.#finishReason === undefined) {
      throw new Error("Chat stream ended without DONE");
    }
    return this.#decodeDone();
  }

  // 身份以首个 chunk 为准。部分聚合网关会在尾部 usage 帧改写或省略 id、model、created；
  // 同一 HTTP 响应内不存在串流可能，后续帧的身份字段不参与校验。
  #start(payload: Record<string, unknown>): CanonicalEvent[] {
    if (this.#identity) {
      return [];
    }
    const id = requireString(payload.id, "id");
    const model = requireString(payload.model, "model");
    const created =
      payload.created === undefined
        ? undefined
        : requireNonNegativeInteger(payload.created, "created");
    this.#identity = { id, model, ...(created === undefined ? {} : { created }) };
    return [
      {
        type: "response_start",
        id,
        model,
        ...(this.options.preserveWireMetadata && created !== undefined
          ? { extensions: { source: "openai-chat", response: { created } } }
          : {}),
      },
    ];
  }

  // finish_reason 之后上游可能补发携带 usage 的空 delta 或重复相同的 finish_reason；
  // 这些帧不含新输出，直接忽略。新的正文、推理、拒答或工具调用仍属协议错误。
  #validateTrailingChoice(choice: Record<string, unknown>, delta: Record<string, unknown>): void {
    const hasOutput =
      ["content", "refusal", "reasoning_content", "reasoning"].some(
        (key) => delta[key] !== undefined && delta[key] !== null && delta[key] !== "",
      ) ||
      (delta.tool_calls !== undefined &&
        delta.tool_calls !== null &&
        !(Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0));
    if (hasOutput) {
      throw new Error("Chat stream emitted content after finish_reason");
    }
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== null &&
      choice.finish_reason !== this.#wireFinishReason
    ) {
      throw new Error("Chat stream emitted finish_reason more than once");
    }
  }

  #validateRole(value: unknown): void {
    if (value !== undefined && value !== null && value !== "assistant") {
      throw new Error("Chat stream delta role must be assistant");
    }
  }

  #decodeReasoning(delta: Record<string, unknown>): CanonicalEvent[] {
    const primary = delta.reasoning_content;
    const alias = delta.reasoning;
    if (primary !== undefined && primary !== null && alias !== undefined && alias !== null) {
      throw new Error("Chat stream cannot emit both reasoning aliases");
    }
    const value = primary ?? alias;
    if (value === undefined || value === null) {
      return [];
    }
    const text = requireString(value, "reasoning delta");
    const events: CanonicalEvent[] = [];
    if (this.#reasoningIndex === undefined) {
      this.#reasoningIndex = this.#open();
      events.push({
        type: "content_start",
        index: this.#reasoningIndex,
        content: { type: "reasoning", text: "", source: "openai-chat" },
      });
    }
    if (text.length > 0) {
      this.#outputLimiter.add(this.#reasoningIndex, text);
      events.push({ type: "reasoning_delta", index: this.#reasoningIndex, delta: text });
    }
    return events;
  }

  #decodeText(value: unknown): CanonicalEvent[] {
    if (value === undefined || value === null) {
      return [];
    }
    const text = requireString(value, "content delta");
    const events: CanonicalEvent[] = [];
    if (this.#textIndex === undefined) {
      this.#textIndex = this.#open();
      events.push({
        type: "content_start",
        index: this.#textIndex,
        content: { type: "text", text: "" },
      });
    }
    if (text.length > 0) {
      this.#outputLimiter.add(this.#textIndex, text);
      events.push({ type: "text_delta", index: this.#textIndex, delta: text });
    }
    return events;
  }

  #decodeRefusal(value: unknown): CanonicalEvent[] {
    if (value === undefined || value === null) return [];
    const text = requireString(value, "refusal delta");
    const events: CanonicalEvent[] = [];
    if (this.#refusalIndex === undefined) {
      this.#refusalIndex = this.#open();
      events.push({
        type: "content_start",
        index: this.#refusalIndex,
        content: { type: "refusal", refusal: "" },
      });
    }
    if (text.length > 0) {
      this.#outputLimiter.add(this.#refusalIndex, text);
      events.push({ type: "text_delta", index: this.#refusalIndex, delta: text });
    }
    return events;
  }

  #decodeTools(value: unknown): CanonicalEvent[] {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error("Chat stream tool_calls must be an array");
    }

    const events: CanonicalEvent[] = [];
    for (const rawCall of value) {
      const call = requireObject(rawCall, "tool call");
      const sourceIndex = requireNonNegativeInteger(call.index, "tool index");
      let state = this.#tools.get(sourceIndex);
      // Chat-compatible providers may serialize absent continuation metadata as null.
      // Only an established call can omit its function; its identity remains unchanged.
      const fn = requireObject(call.function ?? (state ? {} : undefined), "tool function");
      if (!state) {
        if (call.type !== undefined && call.type !== null && call.type !== "function") {
          throw new Error("Chat stream tool call type must be function");
        }
        const id = requireString(call.id, "tool call id");
        const name = requireString(fn.name, "tool function name");
        const canonicalIndex = this.#open();
        this.#outputLimiter.addBytes(canonicalIndex, OUTPUT_ITEM_OVERHEAD_BYTES);
        this.#outputLimiter.addUnrelated(canonicalIndex, id);
        this.#outputLimiter.addUnrelated(canonicalIndex, name);
        state = { canonicalIndex, id, name, arguments: "" };
        this.#tools.set(sourceIndex, state);
        events.push({
          type: "content_start",
          index: canonicalIndex,
          content: { type: "function_call", id, name, arguments: "" },
        });
      } else {
        if (call.type !== undefined && call.type !== null && call.type !== "function") {
          throw new Error("Chat stream tool call type changed");
        }
        if (call.id !== undefined && call.id !== null && call.id !== state.id) {
          throw new Error("Chat stream tool call id changed");
        }
        if (fn.name !== undefined && fn.name !== null && fn.name !== state.name) {
          throw new Error("Chat stream tool function name changed");
        }
      }

      if (fn.arguments !== undefined && fn.arguments !== null) {
        const argumentsDelta = requireString(fn.arguments, "tool arguments delta");
        this.#argumentLimiter.add(sourceIndex, argumentsDelta);
        this.#outputLimiter.add(state.canonicalIndex, argumentsDelta);
        if (this.options.validateToolArguments !== false) state.arguments += argumentsDelta;
        if (argumentsDelta.length > 0) {
          events.push({
            type: "function_arguments_delta",
            index: state.canonicalIndex,
            delta: argumentsDelta,
          });
        }
      }
    }
    return events;
  }

  #open(): number {
    if (this.#finishReason !== undefined) {
      throw new Error("Chat stream emitted content after finish_reason");
    }
    const index = this.#nextContentIndex++;
    this.#openIndices.add(index);
    return index;
  }

  #validateToolArguments(): void {
    for (const [sourceIndex, tool] of this.#tools) {
      const incomplete =
        this.options.allowIncompleteToolArguments === true &&
        this.#finishReason === "max_tokens" &&
        tool.name !== INTERNAL_WEB_SEARCH_TOOL_NAME;
      if (this.options.validateToolArguments !== false && !incomplete) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(tool.arguments);
        } catch {
          throw new Error("Chat stream tool arguments must contain complete JSON");
        }
        if (!isObject(parsed)) {
          throw new Error("Chat stream tool arguments must contain a JSON object");
        }
      }
      this.#argumentLimiter.finish(sourceIndex);
    }
  }

  #decodeDone(): CanonicalEvent[] {
    if (!this.#identity) {
      throw new Error("Chat stream emitted DONE before a response chunk");
    }
    if (this.#finishReason === undefined) {
      throw new Error("Chat stream emitted DONE without finish_reason");
    }
    if (this.#openIndices.size > 0) {
      throw new Error("Chat stream emitted DONE with open content blocks");
    }
    this.#terminal = true;
    return [
      {
        type: "response_complete",
        finishReason: this.#finishReason,
        usage: this.#usage,
        ...(this.options.preserveWireMetadata
          ? {
              extensions: {
                source: "openai-chat" as const,
                response: {
                  ...(this.#identity.created === undefined
                    ? {}
                    : { created: this.#identity.created }),
                  finish_reason: this.#wireFinishReason,
                },
              },
            }
          : {}),
      },
    ];
  }

  #decodeError(error: Record<string, unknown>): CanonicalEvent[] {
    if (!this.#identity) {
      throw new Error("Chat stream failed before its first response chunk");
    }
    this.#terminal = true;
    const canonicalError: CanonicalError = {
      status: optionalNonNegativeInteger(error.status) ?? 500,
      code: typeof error.code === "string" ? error.code : "chat_stream_error",
      message: "The upstream Chat stream failed",
      retryable: false,
    };
    return [{ type: "response_error", error: canonicalError }];
  }
}

function parsePayload(data: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Chat stream event contains invalid JSON");
  }
  return requireObject(value, "event");
}

function decodeFinishReason(value: unknown, hasRefusal: boolean): FinishReason {
  const reason = requireString(value, "finish_reason");
  if (reason === "tool_calls" || reason === "function_call") {
    return "tool_use";
  }
  if (reason === "length") {
    return "max_tokens";
  }
  if (reason === "content_filter" || hasRefusal) {
    return "refusal";
  }
  if (reason === "stop") {
    return "end_turn";
  }
  return "incomplete";
}

function decodeUsage(value: unknown): Usage {
  const usage = requireObject(value, "usage");
  const promptDetails = isObject(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined;
  const completionDetails = isObject(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : undefined;
  const cacheRead = promptDetails
    ? optionalNonNegativeInteger(promptDetails.cached_tokens)
    : undefined;
  const cacheWrite = promptDetails
    ? optionalNonNegativeInteger(promptDetails.cache_write_tokens)
    : undefined;
  const reasoning = completionDetails
    ? optionalNonNegativeInteger(completionDetails.reasoning_tokens)
    : undefined;
  return {
    inputTokens: requireNonNegativeInteger(usage.prompt_tokens, "prompt tokens"),
    outputTokens: requireNonNegativeInteger(usage.completion_tokens, "completion tokens"),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`Chat stream ${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Chat stream ${label} must be a string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const result = optionalNonNegativeInteger(value);
  if (result === undefined) {
    throw new Error(`Chat stream ${label} must be a non-negative integer`);
  }
  return result;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
