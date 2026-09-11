import type { CanonicalEvent } from "../../core/events.js";
import type {
  Citation,
  FunctionCallContent,
  ReasoningContent,
  RefusalContent,
  TextContent,
  Usage,
} from "../../core/ir.js";
import {
  DEFAULT_STREAM_OUTPUT_LIMITS,
  StreamOutputLimiter,
  type StreamOutputLimits,
} from "../../stream/output-limits.js";
import {
  DEFAULT_TOOL_ARGUMENT_LIMITS,
  type ToolArgumentLimits,
  ToolArgumentStreamLimiter,
} from "../../stream/tool-argument-limits.js";
import { encodeWebSearchCall, webSearchCitations, webSearchItemId } from "./web-search.js";

export interface ResponsesSseFrame {
  event: string;
  data: Record<string, unknown>;
}

const OUTPUT_ITEM_OVERHEAD_BYTES = 256;
const CITATION_OVERHEAD_BYTES = 128;

interface ResponseIdentity {
  id: string;
  model: string;
}

type OpenItem =
  | { type: "text"; itemId: string; content: TextContent }
  | { type: "refusal"; itemId: string; content: RefusalContent }
  | { type: "reasoning"; itemId: string; content: ReasoningContent }
  | { type: "function_call"; itemId: string; content: FunctionCallContent };

export class ResponsesStreamEncoder {
  #identity?: ResponseIdentity;
  #sequenceNumber = 0;
  #completed = false;
  readonly #openItems = new Map<number, OpenItem>();
  readonly #outputItems = new Map<number, Record<string, unknown>>();
  readonly #argumentLimiter: ToolArgumentStreamLimiter;
  readonly #outputLimiter: StreamOutputLimiter;
  readonly #contentIndices = new Map<number, number>();
  readonly #searches = new Map<string, { index: number; itemId: string; query: string }>();
  readonly #searchSources: Array<{ title: string; url: string }> = [];
  #searchCount = 0;
  #nextOutputIndex = 0;

  constructor(
    limits: ToolArgumentLimits = DEFAULT_TOOL_ARGUMENT_LIMITS,
    outputLimits: StreamOutputLimits = DEFAULT_STREAM_OUTPUT_LIMITS,
    private readonly options: { includeWebSearchSources?: boolean } = {},
  ) {
    this.#argumentLimiter = new ToolArgumentStreamLimiter(limits);
    this.#outputLimiter = new StreamOutputLimiter(outputLimits);
  }

  encode(event: CanonicalEvent): ResponsesSseFrame[] {
    if (this.#completed) {
      throw new Error("Responses stream is already complete");
    }
    if ("index" in event) {
      if (event.type === "content_start" && !this.#contentIndices.has(event.index)) {
        this.#contentIndices.set(event.index, event.index + this.#searchCount);
      }
      event = { ...event, index: this.#contentIndices.get(event.index) ?? event.index };
    }

    switch (event.type) {
      case "response_start":
        return this.#start(event.id, event.model);
      case "content_start":
        return this.#startContent(event.index, event.itemId, event.content);
      case "text_delta":
        return this.#textDelta(event.index, event.delta);
      case "content_stop":
        return this.#stopContent(event.index, event.status);
      case "response_complete":
        return this.#complete(event.finishReason, event.usage);
      case "response_error":
        return this.#error(event.error.code, event.error.message);
      case "reasoning_delta":
        return this.#reasoningDelta(event.index, event.delta);
      case "reasoning_continuation":
        return this.#reasoningContinuation(event.index, event.opaque);
      case "function_arguments_delta":
        return this.#functionArgumentsDelta(event.index, event.delta);
      case "signature_delta":
        throw new Error("Anthropic signatures cannot be encoded as Responses reasoning");
      case "citation_delta":
        return this.#citationDelta(event.index, event.citation);
      case "web_search_start":
        return this.#startWebSearch(event.id, event.query);
      case "web_search_result":
        return this.#finishWebSearch(event.execution);
    }
  }

  #start(id: string, model: string): ResponsesSseFrame[] {
    if (this.#identity) {
      throw new Error("Responses stream has already started");
    }
    this.#identity = { id, model };
    return [
      this.#frame("response.created", {
        response: this.#response("in_progress", [], null),
      }),
    ];
  }

  #startContent(
    index: number,
    itemId: string | undefined,
    content: Extract<CanonicalEvent, { type: "content_start" }>["content"],
  ): ResponsesSseFrame[] {
    this.#assertStarted();
    if (!itemId) {
      throw new Error("Responses output item ID is required");
    }
    if (this.#openItems.has(index) || this.#outputItems.has(index)) {
      throw new Error(`Responses output item ${index} is already defined`);
    }
    this.#outputLimiter.addBytes(index, OUTPUT_ITEM_OVERHEAD_BYTES);
    this.#nextOutputIndex = Math.max(this.#nextOutputIndex, index + 1);
    this.#outputLimiter.addUnrelated(index, itemId);
    if (content.type === "text") {
      return this.#startText(index, itemId, content);
    }
    if (content.type === "refusal") {
      this.#openItems.set(index, { type: "refusal", itemId, content: { ...content } });
      this.#outputLimiter.add(index, content.refusal);
      return [
        this.#frame("response.output_item.added", {
          output_index: index,
          item: {
            id: itemId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        }),
        this.#frame("response.content_part.added", {
          item_id: itemId,
          output_index: index,
          content_index: 0,
          part: { type: "refusal", refusal: content.refusal },
        }),
      ];
    }
    if (content.type === "reasoning") {
      return this.#startReasoning(index, itemId, content);
    }
    if (content.type === "function_call") {
      return this.#startFunctionCall(index, itemId, content);
    }
    throw new Error(`Unsupported Responses output content: ${content.type}`);
  }

  #startText(index: number, itemId: string, content: TextContent): ResponsesSseFrame[] {
    const item = {
      id: itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    };
    this.#openItems.set(index, { type: "text", itemId, content: { ...content } });
    return [
      this.#frame("response.output_item.added", { output_index: index, item }),
      this.#frame("response.content_part.added", {
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ];
  }

  #startReasoning(index: number, itemId: string, content: ReasoningContent): ResponsesSseFrame[] {
    if (content.opaque !== undefined) {
      this.#validateAndCountContinuation(index, content.opaque);
    }
    const item = {
      id: itemId,
      type: "reasoning",
      status: "in_progress",
      summary: [],
    };
    this.#openItems.set(index, {
      type: "reasoning",
      itemId,
      content: { ...content, text: "" },
    });
    return [
      this.#frame("response.output_item.added", { output_index: index, item }),
      this.#frame("response.reasoning_summary_part.added", {
        item_id: itemId,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    ];
  }

  #startFunctionCall(
    index: number,
    itemId: string,
    content: FunctionCallContent,
  ): ResponsesSseFrame[] {
    this.#outputLimiter.addUnrelated(index, content.id);
    this.#outputLimiter.addUnrelated(index, content.name);
    const item = {
      id: itemId,
      type: "function_call",
      call_id: content.id,
      name: content.name,
      arguments: "",
      status: "in_progress",
    };
    this.#openItems.set(index, {
      type: "function_call",
      itemId,
      content: { ...content, arguments: "" },
    });
    return [this.#frame("response.output_item.added", { output_index: index, item })];
  }

  #textDelta(index: number, delta: string): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (item?.type === "refusal") {
      this.#outputLimiter.add(index, delta);
      item.content.refusal += delta;
      return [
        this.#frame("response.refusal.delta", {
          item_id: item.itemId,
          output_index: index,
          content_index: 0,
          delta,
        }),
      ];
    }
    if (item?.type !== "text") {
      throw new Error(`Responses output item ${index} is not open as text`);
    }
    this.#outputLimiter.add(index, delta);
    item.content.text += delta;
    return [
      this.#frame("response.output_text.delta", {
        item_id: item.itemId,
        output_index: index,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    ];
  }

  #citationDelta(index: number, citation: Citation): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (item?.type !== "text") {
      throw new Error(`Responses output item ${index} is not open as text`);
    }
    this.#outputLimiter.addBytes(index, CITATION_OVERHEAD_BYTES);
    this.#outputLimiter.addUnrelated(index, JSON.stringify(encodeCitation(citation)));
    const citations = item.content.citations ?? [];
    const annotationIndex = citations.length;
    citations.push(citation);
    item.content.citations = citations;
    return [
      this.#frame("response.output_text.annotation.added", {
        item_id: item.itemId,
        output_index: index,
        content_index: 0,
        annotation_index: annotationIndex,
        annotation: encodeCitation(citation),
      }),
    ];
  }

  #reasoningDelta(index: number, delta: string): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (item?.type !== "reasoning") {
      throw new Error(`Responses output item ${index} is not open as reasoning`);
    }
    this.#outputLimiter.add(index, delta);
    item.content.text += delta;
    return [
      this.#frame("response.reasoning_summary_text.delta", {
        item_id: item.itemId,
        output_index: index,
        summary_index: 0,
        delta,
      }),
    ];
  }

  #reasoningContinuation(
    index: number,
    opaque: Extract<CanonicalEvent, { type: "reasoning_continuation" }>["opaque"],
  ): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (item?.type !== "reasoning") {
      throw new Error(`Responses output item ${index} is not open as reasoning`);
    }
    if (item.content.opaque !== undefined) {
      throw new Error("Responses reasoning continuation is already defined");
    }
    this.#validateAndCountContinuation(index, opaque);
    item.content.opaque = { ...opaque };
    return [];
  }

  #validateAndCountContinuation(
    index: number,
    opaque: Extract<CanonicalEvent, { type: "reasoning_continuation" }>["opaque"],
  ): void {
    if (
      opaque.provider !== "openai-responses" ||
      opaque.kind !== "reasoning" ||
      opaque.synthetic === true ||
      opaque.value.length === 0
    ) {
      throw new Error("Invalid Responses reasoning continuation");
    }
    this.#outputLimiter.addUnrelated(index, opaque.value);
  }

  #functionArgumentsDelta(index: number, delta: string): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (item?.type !== "function_call") {
      throw new Error(`Responses output item ${index} is not open as function_call`);
    }
    this.#argumentLimiter.add(index, delta);
    this.#outputLimiter.add(index, delta);
    item.content.arguments += delta;
    return [
      this.#frame("response.function_call_arguments.delta", {
        item_id: item.itemId,
        output_index: index,
        delta,
      }),
    ];
  }

  #stopContent(
    index: number,
    status: Extract<CanonicalEvent, { type: "content_stop" }>["status"] = "completed",
  ): ResponsesSseFrame[] {
    const item = this.#openItems.get(index);
    if (!item) {
      throw new Error(`Responses output item ${index} is not open`);
    }
    const citationFrames: ResponsesSseFrame[] = [];
    if (item.type === "text") {
      for (const citation of webSearchCitations(
        item.content.text,
        this.#searchSources,
        item.content.citations,
      )) {
        citationFrames.push(...this.#citationDelta(index, citation));
      }
    }
    this.#openItems.delete(index);
    if (item.type === "reasoning") {
      return this.#stopReasoning(index, item, status);
    }
    if (item.type === "function_call") {
      return this.#stopFunctionCall(index, item, status);
    }
    if (item.type === "refusal") {
      const part = { type: "refusal", refusal: item.content.refusal };
      const outputItem = {
        id: item.itemId,
        type: "message",
        role: "assistant",
        status,
        content: [part],
      };
      this.#outputItems.set(index, outputItem);
      return [
        this.#frame("response.refusal.done", {
          item_id: item.itemId,
          output_index: index,
          content_index: 0,
          refusal: part.refusal,
        }),
        this.#frame("response.content_part.done", {
          item_id: item.itemId,
          output_index: index,
          content_index: 0,
          part,
        }),
        this.#frame("response.output_item.done", { output_index: index, item: outputItem }),
      ];
    }

    const part = {
      type: "output_text",
      text: item.content.text,
      annotations: item.content.citations?.map(encodeCitation) ?? [],
    };
    const outputItem = {
      id: item.itemId,
      type: "message",
      role: "assistant",
      status,
      content: [part],
    };
    this.#outputItems.set(index, outputItem);
    return [
      ...citationFrames,
      this.#frame("response.output_text.done", {
        item_id: item.itemId,
        output_index: index,
        content_index: 0,
        text: item.content.text,
        logprobs: [],
      }),
      this.#frame("response.content_part.done", {
        item_id: item.itemId,
        output_index: index,
        content_index: 0,
        part,
      }),
      this.#frame("response.output_item.done", { output_index: index, item: outputItem }),
    ];
  }

  #stopReasoning(
    index: number,
    item: Extract<OpenItem, { type: "reasoning" }>,
    status: NonNullable<Extract<CanonicalEvent, { type: "content_stop" }>["status"]>,
  ): ResponsesSseFrame[] {
    const part = { type: "summary_text", text: item.content.text };
    const encrypted =
      item.content.source === "openai-responses" &&
      item.content.opaque?.provider === "openai-responses" &&
      item.content.opaque.kind === "reasoning" &&
      item.content.opaque.synthetic !== true
        ? item.content.opaque.value
        : undefined;
    const outputItem = {
      id: item.itemId,
      type: "reasoning",
      status,
      summary: [part],
      ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
    };
    this.#outputItems.set(index, outputItem);
    return [
      this.#frame("response.reasoning_summary_text.done", {
        item_id: item.itemId,
        output_index: index,
        summary_index: 0,
        text: item.content.text,
      }),
      this.#frame("response.reasoning_summary_part.done", {
        item_id: item.itemId,
        output_index: index,
        summary_index: 0,
        part,
      }),
      this.#frame("response.output_item.done", { output_index: index, item: outputItem }),
    ];
  }

  #stopFunctionCall(
    index: number,
    item: Extract<OpenItem, { type: "function_call" }>,
    status: NonNullable<Extract<CanonicalEvent, { type: "content_stop" }>["status"]>,
  ): ResponsesSseFrame[] {
    this.#argumentLimiter.finish(index);
    const outputItem = {
      id: item.itemId,
      type: "function_call",
      call_id: item.content.id,
      name: item.content.name,
      arguments: item.content.arguments,
      status,
    };
    this.#outputItems.set(index, outputItem);
    return [
      this.#frame("response.function_call_arguments.done", {
        item_id: item.itemId,
        output_index: index,
        name: item.content.name,
        arguments: item.content.arguments,
      }),
      this.#frame("response.output_item.done", { output_index: index, item: outputItem }),
    ];
  }

  #complete(finishReason: string, usage: Usage): ResponsesSseFrame[] {
    this.#assertStarted();
    if (this.#openItems.size > 0 || this.#searches.size > 0) {
      throw new Error("Responses stream cannot complete with open output items");
    }
    this.#completed = true;
    const incomplete = finishReason === "max_tokens" || finishReason === "incomplete";
    const status = incomplete ? "incomplete" : "completed";
    const output = [...this.#outputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
    return [
      this.#frame(incomplete ? "response.incomplete" : "response.completed", {
        response: this.#response(status, output, encodeUsage(usage), finishReason),
      }),
    ];
  }

  #startWebSearch(id: string, query: string): ResponsesSseFrame[] {
    const identity = this.#assertStarted();
    if (this.#searches.has(id)) throw new Error("搜索调用尚未结束");
    const index = this.#nextOutputIndex++;
    const itemId = webSearchItemId(identity.id, id, this.#searchCount++);
    const item = encodeWebSearchCall(itemId, query, "in_progress");
    this.#outputLimiter.addBytes(index, OUTPUT_ITEM_OVERHEAD_BYTES);
    this.#outputLimiter.addUnrelated(index, JSON.stringify(item));
    this.#searches.set(id, { index, itemId, query });
    return [
      this.#frame("response.output_item.added", { output_index: index, item }),
      this.#frame("response.web_search_call.in_progress", { output_index: index, item_id: itemId }),
      this.#frame("response.web_search_call.searching", { output_index: index, item_id: itemId }),
    ];
  }

  #finishWebSearch(
    execution: Extract<CanonicalEvent, { type: "web_search_result" }>["execution"],
  ): ResponsesSseFrame[] {
    const frames = this.#searches.has(execution.id)
      ? []
      : this.#startWebSearch(execution.id, execution.query);
    const search = this.#searches.get(execution.id);
    if (!search || search.query !== execution.query) throw new Error("搜索结果与调用不匹配");
    const sources = execution.results.map(({ title, url }) => ({ title, url }));
    // 来源用于后续引用，即使未请求 sources 字段，也必须计入驻留内存限额。
    this.#outputLimiter.addUnrelated(search.index, JSON.stringify(sources));
    const item = encodeWebSearchCall(
      search.itemId,
      search.query,
      "completed",
      this.options.includeWebSearchSources ? sources : undefined,
    );
    this.#outputLimiter.addUnrelated(search.index, JSON.stringify(item));
    this.#searchSources.push(...sources);
    this.#outputItems.set(search.index, { ...item });
    this.#searches.delete(execution.id);
    return [
      ...frames,
      this.#frame("response.web_search_call.completed", {
        output_index: search.index,
        item_id: search.itemId,
      }),
      this.#frame("response.output_item.done", { output_index: search.index, item }),
    ];
  }

  #error(code: string, message: string): ResponsesSseFrame[] {
    this.#assertStarted();
    this.#completed = true;
    return [this.#frame("error", { code, message, param: null })];
  }

  #response(
    status: "in_progress" | "completed" | "incomplete",
    output: Record<string, unknown>[],
    usage: Record<string, unknown> | null,
    finishReason?: string,
  ): Record<string, unknown> {
    const identity = this.#assertStarted();
    return {
      id: identity.id,
      object: "response",
      model: identity.model,
      status,
      output,
      error: null,
      incomplete_details:
        status === "incomplete"
          ? { reason: finishReason === "max_tokens" ? "max_output_tokens" : "content_filter" }
          : null,
      usage,
    };
  }

  #frame(type: string, body: Record<string, unknown>): ResponsesSseFrame {
    return {
      event: type,
      data: { type, ...body, sequence_number: this.#sequenceNumber++ },
    };
  }

  #assertStarted(): ResponseIdentity {
    if (!this.#identity) {
      throw new Error("Responses stream has not started");
    }
    return this.#identity;
  }
}

function encodeCitation(citation: Citation) {
  return {
    type: "url_citation",
    url: citation.url,
    ...(citation.title === undefined ? {} : { title: citation.title }),
    ...(citation.startIndex === undefined ? {} : { start_index: citation.startIndex }),
    ...(citation.endIndex === undefined ? {} : { end_index: citation.endIndex }),
  };
}

function encodeUsage(usage: Usage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadInputTokens === undefined && usage.cacheWriteInputTokens === undefined
      ? {}
      : {
          input_tokens_details: {
            ...(usage.cacheReadInputTokens === undefined
              ? {}
              : { cached_tokens: usage.cacheReadInputTokens }),
            ...(usage.cacheWriteInputTokens === undefined
              ? {}
              : { cache_write_tokens: usage.cacheWriteInputTokens }),
          },
        }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  };
}
