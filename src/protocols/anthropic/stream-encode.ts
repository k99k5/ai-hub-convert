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
const CITATION_OVERHEAD_BYTES = 128;
const WEB_SEARCH_RESULT_OVERHEAD_BYTES = 128;

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
  webSearchExecutions?: readonly {
    id: string;
    query: string;
    results: readonly { title: string; url: string; content: string }[];
  }[];
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
  readonly #contentIndexOffset: number;

  constructor(private readonly options: AnthropicStreamEncoderOptions = {}) {
    this.#argumentLimiter = new ToolArgumentStreamLimiter(
      options.toolArgumentLimits ?? DEFAULT_TOOL_ARGUMENT_LIMITS,
    );
    this.#outputLimiter = new StreamOutputLimiter(
      options.outputLimits ?? DEFAULT_STREAM_OUTPUT_LIMITS,
    );
    this.#contentIndexOffset = (options.webSearchExecutions?.length ?? 0) * 2;
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
      case "text_delta": {
        this.#assertOpen(event.index, "text");
        const outputIndex = this.#outputIndex(event.index);
        this.#outputLimiter.add(outputIndex, event.delta);
        return [
          frame("content_block_delta", outputIndex, { type: "text_delta", text: event.delta }),
        ];
      }
      case "reasoning_delta": {
        this.#assertOpen(event.index, "reasoning");
        const outputIndex = this.#outputIndex(event.index);
        this.#outputLimiter.add(outputIndex, event.delta);
        return [
          frame("content_block_delta", outputIndex, {
            type: "thinking_delta",
            thinking: event.delta,
          }),
        ];
      }
      case "reasoning_continuation":
        this.#assertOpen(event.index, "reasoning");
        return [];
      case "signature_delta": {
        const block = this.#assertOpen(event.index, "reasoning");
        const outputIndex = this.#outputIndex(event.index);
        this.#outputLimiter.add(outputIndex, event.delta);
        block.signature += event.delta;
        return [
          frame("content_block_delta", outputIndex, {
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
        const outputIndex = this.#outputIndex(event.index);
        this.#outputLimiter.add(outputIndex, event.delta);
        return [
          frame("content_block_delta", outputIndex, {
            type: "input_json_delta",
            partial_json: event.delta,
          }),
        ];
      }
      case "citation_delta": {
        this.#assertOpen(event.index, "text");
        const outputIndex = this.#outputIndex(event.index);
        this.#outputLimiter.addBytes(outputIndex, CITATION_OVERHEAD_BYTES);
        this.#outputLimiter.addUnrelated(outputIndex, event.citation.url);
        if (event.citation.title !== undefined) {
          this.#outputLimiter.addUnrelated(outputIndex, event.citation.title);
        }
        return [
          frame("content_block_delta", outputIndex, {
            type: "citations_delta",
            citation: encodeCitation(event.citation),
          }),
        ];
      }
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
      ...this.#webSearchPrefixFrames(),
    ];
  }

  #startContent(index: number, content: Content): AnthropicSseFrame[] {
    this.#assertStarted();
    if (this.#seenIndices.has(index)) {
      throw new Error(`Anthropic content block ${index} is already defined`);
    }
    this.#seenIndices.add(index);
    const outputIndex = this.#outputIndex(index);
    this.#outputLimiter.addBytes(outputIndex, OUTPUT_ITEM_OVERHEAD_BYTES);
    if (content.type === "function_call") {
      this.#outputLimiter.addUnrelated(outputIndex, content.id);
      this.#outputLimiter.addUnrelated(outputIndex, content.name);
    }
    const contentBlock = encodeContentStart(content);
    this.#openBlocks.set(index, {
      content,
      deltas: [],
      signature: content.type === "reasoning" ? (content.signature ?? "") : "",
    });
    const frames: AnthropicSseFrame[] = [
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: outputIndex, content_block: contentBlock },
      },
    ];
    if (content.type === "refusal" && content.refusal.length > 0) {
      this.#outputLimiter.add(outputIndex, content.refusal);
      frames.push(
        frame("content_block_delta", outputIndex, {
          type: "text_delta",
          text: content.refusal,
        }),
      );
    }
    return frames;
  }

  #stopContent(index: number): AnthropicSseFrame[] {
    this.#assertStarted();
    const block = this.#openBlocks.get(index);
    if (!block) {
      throw new Error(`Anthropic content block ${index} is not open`);
    }

    const outputIndex = this.#outputIndex(index);
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
      this.#outputLimiter.add(outputIndex, normalized.json);
      frames.push(
        frame("content_block_delta", outputIndex, {
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
        this.#outputLimiter.add(outputIndex, finalized.signature);
        frames.push(
          frame("content_block_delta", outputIndex, {
            type: "signature_delta",
            signature: finalized.signature,
          }),
        );
      }
    }

    this.#openBlocks.delete(index);
    frames.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: outputIndex },
    });
    return frames;
  }

  #outputIndex(index: number): number {
    return index + this.#contentIndexOffset;
  }

  #webSearchPrefixFrames(): AnthropicSseFrame[] {
    const frames: AnthropicSseFrame[] = [];
    for (const [searchIndex, execution] of (this.options.webSearchExecutions ?? []).entries()) {
      const toolUseId = `srvtoolu_ai_hub_${searchIndex}`;
      const toolIndex = searchIndex * 2;
      const resultIndex = toolIndex + 1;
      const queryJson = JSON.stringify({ query: execution.query });

      this.#outputLimiter.addBytes(toolIndex, OUTPUT_ITEM_OVERHEAD_BYTES);
      this.#outputLimiter.addUnrelated(toolIndex, toolUseId);
      this.#outputLimiter.addUnrelated(toolIndex, "web_search");
      this.#outputLimiter.add(toolIndex, queryJson);
      frames.push(
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: toolIndex,
            content_block: { type: "server_tool_use", id: toolUseId, name: "web_search" },
          },
        },
        frame("content_block_delta", toolIndex, {
          type: "input_json_delta",
          partial_json: queryJson,
        }),
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: toolIndex },
        },
      );

      this.#outputLimiter.addBytes(resultIndex, OUTPUT_ITEM_OVERHEAD_BYTES);
      this.#outputLimiter.addUnrelated(resultIndex, toolUseId);
      for (const result of execution.results) {
        this.#outputLimiter.addBytes(resultIndex, WEB_SEARCH_RESULT_OVERHEAD_BYTES);
        this.#outputLimiter.addUnrelated(resultIndex, result.title);
        this.#outputLimiter.addUnrelated(resultIndex, result.url);
      }
      frames.push(
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: resultIndex,
            content_block: {
              type: "web_search_tool_result",
              tool_use_id: toolUseId,
              content: execution.results.map((result) => ({
                type: "web_search_result",
                title: result.title,
                url: result.url,
              })),
            },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: resultIndex },
        },
      );
    }
    return frames;
  }

  #complete(event: Extract<CanonicalEvent, { type: "response_complete" }>): AnthropicSseFrame[] {
    this.#assertStarted();
    if (this.#openBlocks.size > 0) {
      throw new Error("Anthropic stream cannot complete with open content blocks");
    }
    this.#completed = true;
    const usage = encodeUsage(event.usage);
    const webSearchExecutions = this.options.webSearchExecutions ?? [];
    const nativeResultCount = webSearchExecutions.reduce(
      (count, execution) => count + execution.results.length,
      0,
    );
    process.stderr.write(
      `[web-search-debug] ${JSON.stringify({
        event: "anthropic_stream_complete",
        canonicalWebSearchRequests: event.usage.webSearchRequests,
        encodedServerToolUse: usage.server_tool_use,
        nativeSearchBlocks: webSearchExecutions.length,
        nativeSearchResults: nativeResultCount,
      })}\n`,
    );
    if (webSearchExecutions.length > 0) {
      process.stderr.write(
        `[web-search-debug] ${JSON.stringify({
          event: "native_web_search_emitted",
          searches: webSearchExecutions.length,
          results: nativeResultCount,
          queryLengths: webSearchExecutions.map((execution) => execution.query.length),
        })}\n`,
      );
    }
    return [
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: {
            stop_reason: encodeStopReason(event.finishReason),
            stop_sequence: event.stopSequence ?? null,
          },
          usage,
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

function encodeUsage(usage: Usage): Record<string, unknown> {
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
    ...(usage.webSearchRequests !== undefined
      ? { server_tool_use: { web_search_requests: usage.webSearchRequests } }
      : {}),
  };
}
