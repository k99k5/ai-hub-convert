import type { CanonicalEvent } from "../../core/events.js";
import type { Content, Usage } from "../../core/ir.js";
import { normalizeReadToolArguments } from "../../policies/read-tool.js";
import { finalizeThinkingBlock } from "../../policies/thinking-signature.js";
import {
  DEFAULT_STREAM_OUTPUT_LIMITS,
  type StreamOutputLimits,
  StreamOutputLimiter,
} from "../../stream/output-limits.js";
import {
  DEFAULT_TOOL_ARGUMENT_LIMITS,
  type ToolArgumentLimits,
  ToolArgumentStreamLimiter,
} from "../../stream/tool-argument-limits.js";

const OUTPUT_ITEM_OVERHEAD_BYTES = 256;

export interface AnthropicSseFrame {
  event: string;
  data: Record<string, unknown>;
}

export interface AnthropicStreamEncoderOptions {
  readToolCompatEnabled?: boolean;
  syntheticThinkingSignatureEnabled?: boolean;
  uuidFactory?: () => string;
  toolArgumentLimits?: ToolArgumentLimits;
  outputLimits?: StreamOutputLimits;
}

interface OpenBlock {
  content: Content;
  deltas: string[];
  signature: string;
}

export class AnthropicStreamEncoder {
  #started = false;
  #completed = false;
  readonly #openBlocks = new Map<number, OpenBlock>();
  readonly #seenIndices = new Set<number>();
  readonly #argumentLimiter: ToolArgumentStreamLimiter;
  readonly #outputLimiter: StreamOutputLimiter;

  constructor(private readonly options: AnthropicStreamEncoderOptions = {}) {
    this.#argumentLimiter = new ToolArgumentStreamLimiter(
      options.toolArgumentLimits ?? DEFAULT_TOOL_ARGUMENT_LIMITS,
    );
    this.#outputLimiter = new StreamOutputLimiter(
      options.outputLimits ?? DEFAULT_STREAM_OUTPUT_LIMITS,
    );
  }

  encode(event: CanonicalEvent): AnthropicSseFrame[] {
    if (this.#completed) {
      throw new Error("Anthropic stream is already complete");
    }

    switch (event.type) {
      case "response_start":
        return this.#start(event);
      case "content_start":
        return this.#startContent(event.index, event.content);
      case "text_delta":
        this.#assertOpen(event.index, "text");
        return [
          frame("content_block_delta", event.index, { type: "text_delta", text: event.delta }),
        ];
      case "reasoning_delta":
        this.#assertOpen(event.index, "reasoning");
        return [
          frame("content_block_delta", event.index, {
            type: "thinking_delta",
            thinking: event.delta,
          }),
        ];
      case "reasoning_continuation":
        this.#assertOpen(event.index, "reasoning");
        return [];
      case "signature_delta": {
        const block = this.#assertOpen(event.index, "reasoning");
        block.signature += event.delta;
        return [
          frame("content_block_delta", event.index, {
            type: "signature_delta",
            signature: event.delta,
          }),
        ];
      }
      case "function_arguments_delta": {
        const block = this.#assertOpen(event.index, "function_call");
        if (
          this.options.readToolCompatEnabled === true &&
          block.content.type === "function_call" &&
          /^read$/i.test(block.content.name)
        ) {
          this.#argumentLimiter.add(event.index, event.delta);
          block.deltas.push(event.delta);
          return [];
        }
        return [
          frame("content_block_delta", event.index, {
            type: "input_json_delta",
            partial_json: event.delta,
          }),
        ];
      }
      case "citation_delta":
        this.#assertOpen(event.index, "text");
        return [
          frame("content_block_delta", event.index, {
            type: "citations_delta",
            citation: encodeCitation(event.citation),
          }),
        ];
      case "content_stop":
        return this.#stopContent(event.index);
      case "response_complete":
        return this.#complete(event);
      case "response_error":
        this.#assertStarted();
        this.#completed = true;
        return [
          {
            event: "error",
            data: {
              type: "error",
              error: { type: "api_error", message: event.error.message },
            },
          },
        ];
    }
  }

  #start(event: Extract<CanonicalEvent, { type: "response_start" }>): AnthropicSseFrame[] {
    if (this.#started) {
      throw new Error("Anthropic stream has already started");
    }
    this.#started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: event.id,
            type: "message",
            role: "assistant",
            model: event.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
    ];
  }

  #startContent(index: number, content: Content): AnthropicSseFrame[] {
    this.#assertStarted();
    if (this.#seenIndices.has(index)) {
      throw new Error(`Anthropic content block ${index} is already defined`);
    }
    this.#seenIndices.add(index);
    this.#outputLimiter.addBytes(index, OUTPUT_ITEM_OVERHEAD_BYTES);
    if (content.type === "function_call") {
      this.#outputLimiter.addUnrelated(index, content.id);
      this.#outputLimiter.addUnrelated(index, content.name);
    }
    const contentBlock = encodeContentStart(content);
    this.#openBlocks.set(index, {
      content,
      deltas: [],
      signature: content.type === "reasoning" ? (content.signature ?? "") : "",
    });
    return [
      {
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block: contentBlock },
      },
    ];
  }

  #stopContent(index: number): AnthropicSseFrame[] {
    this.#assertStarted();
    const block = this.#openBlocks.get(index);
    if (!block) {
      throw new Error(`Anthropic content block ${index} is not open`);
    }

    const frames: AnthropicSseFrame[] = [];
    if (
      block.content.type === "function_call" &&
      this.options.readToolCompatEnabled === true &&
      /^read$/i.test(block.content.name)
    ) {
      this.#argumentLimiter.finish(index);
      const normalized = normalizeReadToolArguments(
        block.content.name,
        block.deltas.join(""),
        true,
      );
      frames.push(
        frame("content_block_delta", index, {
          type: "input_json_delta",
          partial_json: normalized.json,
        }),
      );
    } else if (block.content.type === "reasoning" && !block.signature) {
      const finalized = finalizeThinkingBlock(
        { text: "" },
        {
          enabled: this.options.syntheticThinkingSignatureEnabled === true,
          ...(this.options.uuidFactory === undefined
            ? {}
            : { uuidFactory: this.options.uuidFactory }),
        },
      );
      if ("signature" in finalized) {
        frames.push(
          frame("content_block_delta", index, {
            type: "signature_delta",
            signature: finalized.signature,
          }),
        );
      }
    }

    this.#openBlocks.delete(index);
    frames.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    return frames;
  }

  #complete(event: Extract<CanonicalEvent, { type: "response_complete" }>): AnthropicSseFrame[] {
    this.#assertStarted();
    if (this.#openBlocks.size > 0) {
      throw new Error("Anthropic stream cannot complete with open content blocks");
    }
    this.#completed = true;
    return [
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: {
            stop_reason: encodeStopReason(event.finishReason),
            stop_sequence: event.stopSequence ?? null,
          },
          usage: encodeUsage(event.usage),
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
  }

  #assertStarted(): void {
    if (!this.#started) {
      throw new Error("Anthropic stream has not started");
    }
  }

  #assertOpen(index: number, expected: Content["type"]): OpenBlock {
    this.#assertStarted();
    const block = this.#openBlocks.get(index);
    if (block?.content.type !== expected) {
      throw new Error(`Anthropic content block ${index} is not open as ${expected}`);
    }
    return block;
  }
}

function encodeStopReason(
  finishReason: Extract<CanonicalEvent, { type: "response_complete" }>["finishReason"],
) {
  return finishReason === "incomplete" ? "pause_turn" : finishReason;
}

function frame(event: string, index: number, delta: Record<string, unknown>): AnthropicSseFrame {
  return { event, data: { type: event, index, delta } };
}

function encodeContentStart(content: Content): Record<string, unknown> {
  switch (content.type) {
    case "text":
      return { type: "text", text: "" };
    case "reasoning":
      return { type: "thinking", thinking: "", signature: "" };
    case "function_call":
      return { type: "tool_use", id: content.id, name: content.name, input: {} };
    case "refusal":
      return { type: "text", text: "" };
    case "search_result":
      return {
        type: "search_result",
        title: content.title,
        source: content.source,
        content: [{ type: "text", text: content.content }],
        citations: { enabled: content.citationsEnabled },
      };
    case "image":
      return content.source.type === "url"
        ? { type: "image", source: { type: "url", url: content.source.url } }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: content.source.mediaType,
              data: content.source.data,
            },
          };
    case "function_result":
      throw new Error("Function results cannot appear in an Anthropic assistant stream");
  }
}

function encodeCitation(citation: {
  type: "url";
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}): Record<string, unknown> {
  return {
    type: "web_search_result_location",
    url: citation.url,
    ...(citation.title ? { title: citation.title } : {}),
    ...(citation.startIndex !== undefined ? { cited_text_start: citation.startIndex } : {}),
    ...(citation.endIndex !== undefined ? { cited_text_end: citation.endIndex } : {}),
  };
}

function encodeUsage(usage: Usage): Record<string, number> {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  return {
    input_tokens: Math.max(0, usage.inputTokens - cacheRead - cacheWrite),
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cache_creation_input_tokens: usage.cacheWriteInputTokens }
      : {}),
  };
}
