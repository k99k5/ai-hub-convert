import { createHash, type Hash } from "node:crypto";
import type { CanonicalError, CanonicalEvent } from "../../core/events.js";
import type { FinishReason, Usage } from "../../core/ir.js";
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

interface StreamItem {
  type: "message" | "reasoning" | "function_call";
  itemId: string;
  callId?: string;
  name?: string;
  bodyHash: Hash;
  annotationHash: Hash;
  annotationCount: number;
}

interface ParsedMessageBody {
  text: string;
  refusalText: string;
  annotations: Array<{
    hashValue: string;
    citation: Extract<CanonicalEvent, { type: "citation_delta" }>["citation"];
  }>;
}

const OUTPUT_ITEM_OVERHEAD_BYTES = 256;

const IGNORED_EVENTS = new Set([
  "response.in_progress",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.done",
  "response.function_call_arguments.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.done",
]);

export class ResponsesStreamDecoder {
  #started = false;
  #terminal = false;
  #hasFunctionCall = false;
  #hasRefusal = false;
  readonly #items = new Map<number, StreamItem>();
  readonly #seenIndices = new Set<number>();
  readonly #argumentLimiter: ToolArgumentStreamLimiter;
  readonly #outputLimiter: StreamOutputLimiter;

  constructor(
    limits: ToolArgumentLimits = DEFAULT_TOOL_ARGUMENT_LIMITS,
    outputLimits: StreamOutputLimits = DEFAULT_STREAM_OUTPUT_LIMITS,
  ) {
    this.#argumentLimiter = new ToolArgumentStreamLimiter(limits);
    this.#outputLimiter = new StreamOutputLimiter(outputLimits);
  }

  decode(frame: SseEvent): CanonicalEvent[] {
    if (frame.data === "[DONE]") {
      if (!this.#terminal) {
        throw new Error("Responses stream emitted DONE before its terminal event");
      }
      return [];
    }
    const payload = parsePayload(frame.data);
    const type = readString(payload, "type");
    if (type !== frame.event && frame.event !== "message") {
      throw new Error("Responses event type does not match its SSE event name");
    }
    if (this.#terminal) {
      throw new Error("Responses stream received data after its terminal event");
    }

    switch (type) {
      case "response.created":
        return this.#decodeCreated(payload);
      case "response.output_item.added":
        return this.#decodeItemAdded(payload);
      case "response.output_text.delta":
        return [this.#decodeDelta(payload, "message", "text_delta")];
      case "response.output_text.annotation.added":
        return [this.#decodeAnnotation(payload)];
      case "response.reasoning_summary_text.delta":
        return [this.#decodeDelta(payload, "reasoning", "reasoning_delta")];
      case "response.function_call_arguments.delta":
        return [this.#decodeFunctionArgumentsDelta(payload)];
      case "response.output_item.done":
        return this.#decodeItemDone(payload);
      case "response.completed":
        return this.#decodeCompleted(payload);
      case "response.incomplete":
        return this.#decodeIncomplete(payload);
      case "response.failed":
      case "response.cancelled":
      case "error":
        return this.#decodeFailure(payload, type);
      default:
        if (IGNORED_EVENTS.has(type)) {
          return [];
        }
        throw new Error(`Unsupported Responses stream event: ${type}`);
    }
  }

  finish(): void {
    if (!this.#terminal) {
      throw new Error("Responses stream ended without a terminal event");
    }
  }

  #decodeCreated(payload: Record<string, unknown>): CanonicalEvent[] {
    if (this.#started) {
      throw new Error("Responses stream emitted response.created more than once");
    }
    const response = readObject(payload, "response");
    this.#started = true;
    return [
      {
        type: "response_start",
        id: readString(response, "id"),
        model: readString(response, "model"),
      },
    ];
  }

  #decodeItemAdded(payload: Record<string, unknown>): CanonicalEvent[] {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    if (this.#seenIndices.has(index)) {
      throw new Error(`Responses output item ${index} is already defined`);
    }
    this.#seenIndices.add(index);
    const item = readObject(payload, "item");
    const itemId = readString(item, "id");
    const itemType = readString(item, "type");
    this.#outputLimiter.addBytes(index, OUTPUT_ITEM_OVERHEAD_BYTES);
    this.#outputLimiter.addUnrelated(index, itemId);

    if (itemType === "message") {
      if (item.role !== "assistant") {
        throw new Error(`Responses output item ${index} role must be assistant`);
      }
      const body = readMessageBody(item, index);
      const streamItem: StreamItem = {
        type: "message",
        itemId,
        bodyHash: createHash("sha256"),
        annotationHash: createHash("sha256"),
        annotationCount: body.annotations.length,
      };
      streamItem.bodyHash.update(body.text, "utf8");
      for (const annotation of body.annotations) {
        updateAnnotationHash(streamItem.annotationHash, annotation.hashValue);
      }
      this.#items.set(index, streamItem);
      return [
        { type: "content_start", index, itemId, content: { type: "text", text: "" } },
        ...(body.text.length === 0
          ? []
          : ([{ type: "text_delta", index, delta: body.text }] satisfies CanonicalEvent[])),
        ...body.annotations.map(
          ({ citation }): CanonicalEvent => ({ type: "citation_delta", index, citation }),
        ),
      ];
    }
    if (itemType === "reasoning") {
      const body = readReasoningText(item, index);
      const streamItem: StreamItem = {
        type: "reasoning",
        itemId,
        bodyHash: createHash("sha256"),
        annotationHash: createHash("sha256"),
        annotationCount: 0,
      };
      streamItem.bodyHash.update(body, "utf8");
      this.#items.set(index, streamItem);
      return [
        {
          type: "content_start",
          index,
          itemId,
          content: { type: "reasoning", id: itemId, text: "", source: "openai-responses" },
        },
        ...(body.length === 0
          ? []
          : ([{ type: "reasoning_delta", index, delta: body }] satisfies CanonicalEvent[])),
      ];
    }
    if (itemType === "function_call") {
      const callId = readString(item, "call_id");
      const name = readString(item, "name");
      this.#outputLimiter.addUnrelated(index, callId);
      this.#outputLimiter.addUnrelated(index, name);
      const body = readOptionalString(item, "arguments") ?? "";
      const streamItem: StreamItem = {
        type: "function_call",
        itemId,
        callId,
        name,
        bodyHash: createHash("sha256"),
        annotationHash: createHash("sha256"),
        annotationCount: 0,
      };
      streamItem.bodyHash.update(body, "utf8");
      if (body.length > 0) {
        this.#argumentLimiter.add(index, body);
      }
      this.#items.set(index, streamItem);
      this.#hasFunctionCall = true;
      return [
        {
          type: "content_start",
          index,
          itemId,
          content: { type: "function_call", id: callId, name, arguments: "" },
        },
        ...(body.length === 0
          ? []
          : ([
              { type: "function_arguments_delta", index, delta: body },
            ] satisfies CanonicalEvent[])),
      ];
    }

    throw new Error(`Unsupported Responses output item: ${itemType}`);
  }

  #decodeDelta(
    payload: Record<string, unknown>,
    expected: StreamItem["type"],
    eventType: "text_delta" | "reasoning_delta" | "function_arguments_delta",
  ): CanonicalEvent {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    const item = this.#items.get(index);
    if (item?.type !== expected) {
      throw new Error(`Responses output item ${index} is not open as ${expected}`);
    }
    const delta = readString(payload, "delta");
    item.bodyHash.update(delta, "utf8");
    return { type: eventType, index, delta };
  }

  #decodeFunctionArgumentsDelta(payload: Record<string, unknown>): CanonicalEvent {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    const item = this.#items.get(index);
    if (item?.type !== "function_call") {
      throw new Error(`Responses output item ${index} is not open as function_call`);
    }
    const delta = readString(payload, "delta");
    this.#argumentLimiter.add(index, delta);
    item.bodyHash.update(delta, "utf8");
    return { type: "function_arguments_delta", index, delta };
  }

  #decodeAnnotation(payload: Record<string, unknown>): CanonicalEvent {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    const item = this.#items.get(index);
    if (item?.type !== "message") {
      throw new Error(`Responses output item ${index} is not open as message`);
    }
    if (readString(payload, "item_id") !== item.itemId) {
      throw new Error(`Responses output item ${index} changed its item ID`);
    }
    if (readInteger(payload, "content_index") !== 0) {
      throw new Error("Responses message annotation content index must be zero");
    }
    const annotationIndex = readInteger(payload, "annotation_index");
    if (annotationIndex !== item.annotationCount) {
      throw new Error("Responses message annotations must be emitted in order");
    }
    const annotation = parseAnnotation(readObject(payload, "annotation"));
    updateAnnotationHash(item.annotationHash, annotation.hashValue);
    item.annotationCount++;
    return {
      type: "citation_delta",
      index,
      citation: annotation.citation,
    };
  }

  #decodeItemDone(payload: Record<string, unknown>): CanonicalEvent[] {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    const openItem = this.#items.get(index);
    if (!openItem) {
      throw new Error(`Responses output item ${index} is not open`);
    }
    const doneItem = readObject(payload, "item");
    const doneBody = this.#assertDoneItemMatches(index, openItem, doneItem);
    this.#items.delete(index);
    if (openItem.type === "function_call") {
      this.#argumentLimiter.finish(index);
    }

    const events: CanonicalEvent[] = [];
    if (openItem.type === "message" && doneBody !== undefined && doneBody.refusalText.length > 0) {
      this.#hasRefusal = true;
      events.push({ type: "text_delta", index, delta: doneBody.refusalText });
    }
    if (openItem.type === "reasoning") {
      const encrypted = doneItem.encrypted_content;
      if (encrypted !== undefined && encrypted !== null) {
        if (typeof encrypted !== "string" || encrypted.length === 0) {
          throw new Error(`Responses output item ${index} has invalid encrypted content`);
        }
        events.push({
          type: "reasoning_continuation",
          index,
          opaque: {
            provider: "openai-responses",
            kind: "reasoning",
            value: encrypted,
          },
        });
      }
    }
    events.push({ type: "content_stop", index });
    return events;
  }

  #assertDoneItemMatches(
    index: number,
    openItem: StreamItem,
    doneItem: Record<string, unknown>,
  ): ParsedMessageBody | undefined {
    if (
      readString(doneItem, "id") !== openItem.itemId ||
      readString(doneItem, "type") !== openItem.type
    ) {
      throw new Error(`Responses output item ${index} done identity does not match`);
    }

    let doneBody: string;
    let doneAnnotations: string[] = [];
    let message: ParsedMessageBody | undefined;
    if (openItem.type === "message") {
      if (doneItem.role !== "assistant") {
        throw new Error(`Responses output item ${index} done role does not match`);
      }
      message = readMessageBody(doneItem, index);
      doneBody = message.text;
      doneAnnotations = message.annotations.map((annotation) => annotation.hashValue);
    } else if (openItem.type === "reasoning") {
      doneBody = readReasoningText(doneItem, index);
    } else {
      if (
        readString(doneItem, "call_id") !== openItem.callId ||
        readString(doneItem, "name") !== openItem.name
      ) {
        throw new Error(`Responses output item ${index} done function does not match`);
      }
      doneBody = readString(doneItem, "arguments");
      assertJsonObject(doneBody, `Responses output item ${index} arguments`);
    }

    if (openItem.bodyHash.digest("hex") !== hashText(doneBody)) {
      throw new Error(`Responses output item ${index} done body does not match`);
    }
    const doneAnnotationHash = createHash("sha256");
    for (const annotation of doneAnnotations) {
      updateAnnotationHash(doneAnnotationHash, annotation);
    }
    if (
      doneAnnotations.length !== openItem.annotationCount ||
      openItem.annotationHash.digest("hex") !== doneAnnotationHash.digest("hex")
    ) {
      throw new Error(`Responses output item ${index} done annotations do not match`);
    }
    return message;
  }

  #decodeCompleted(payload: Record<string, unknown>): CanonicalEvent[] {
    this.#assertCanTerminate();
    const response = readObject(payload, "response");
    this.#terminal = true;
    return [
      {
        type: "response_complete",
        finishReason: this.#hasFunctionCall
          ? "tool_use"
          : this.#hasRefusal
            ? "refusal"
            : inferFinishReason(response),
        usage: decodeUsage(response.usage),
      },
    ];
  }

  #decodeIncomplete(payload: Record<string, unknown>): CanonicalEvent[] {
    this.#assertCanTerminate();
    const response = readObject(payload, "response");
    this.#terminal = true;
    return [
      {
        type: "response_complete",
        finishReason: inferFinishReason(response),
        usage: decodeUsage(response.usage),
      },
    ];
  }

  #decodeFailure(payload: Record<string, unknown>, _eventType: string): CanonicalEvent[] {
    this.#assertStarted();
    this.#terminal = true;
    const error = payload.error && isObject(payload.error) ? payload.error : payload;
    const canonicalError: CanonicalError = {
      status: readOptionalInteger(error, "status") ?? 500,
      code: "responses_stream_error",
      message: "The upstream Responses stream failed",
      retryable: false,
    };
    return [{ type: "response_error", error: canonicalError }];
  }

  #assertStarted(): void {
    if (!this.#started) {
      throw new Error("Responses stream has not emitted response.created");
    }
  }

  #assertCanTerminate(): void {
    this.#assertStarted();
    if (this.#items.size > 0) {
      throw new Error("Responses stream terminated with open output items");
    }
  }
}

function readMessageBody(item: Record<string, unknown>, index: number): ParsedMessageBody {
  if (!Array.isArray(item.content)) {
    throw new Error(`Responses output item ${index} content does not match`);
  }
  const annotations: ParsedMessageBody["annotations"] = [];
  const textParts: string[] = [];
  const refusalParts: string[] = [];
  for (const rawPart of item.content) {
    if (!isObject(rawPart)) {
      throw new Error(`Responses output item ${index} content does not match`);
    }
    if (rawPart.type === "output_text") {
      const rawAnnotations = rawPart.annotations;
      if (rawAnnotations !== undefined && !Array.isArray(rawAnnotations)) {
        throw new Error(`Responses output item ${index} annotations do not match`);
      }
      const partAnnotations = Array.isArray(rawAnnotations) ? rawAnnotations : [];
      annotations.push(...partAnnotations.map((value) => parseAnnotationValue(value)));
      textParts.push(readString(rawPart, "text"));
      continue;
    }
    if (rawPart.type === "refusal") {
      refusalParts.push(readString(rawPart, "refusal"));
      continue;
    }
    throw new Error(`Responses output item ${index} content does not match`);
  }
  return { text: textParts.join(""), refusalText: refusalParts.join(""), annotations };
}

function readReasoningText(item: Record<string, unknown>, index: number): string {
  if (!Array.isArray(item.summary)) {
    throw new Error(`Responses output item ${index} summary does not match`);
  }
  return item.summary
    .map((rawPart) => {
      if (!isObject(rawPart) || rawPart.type !== "summary_text") {
        throw new Error(`Responses output item ${index} summary does not match`);
      }
      return readString(rawPart, "text");
    })
    .join("");
}

function parseAnnotationValue(value: unknown): ParsedMessageBody["annotations"][number] {
  if (!isObject(value)) {
    throw new Error("Responses output text annotation must be an object");
  }
  return parseAnnotation(value);
}

function parseAnnotation(
  annotation: Record<string, unknown>,
): ParsedMessageBody["annotations"][number] {
  if (readString(annotation, "type") !== "url_citation") {
    throw new Error("Unsupported Responses output text annotation");
  }
  const url = readString(annotation, "url");
  const title = readOptionalString(annotation, "title");
  const startIndex = readOptionalInteger(annotation, "start_index");
  const endIndex = readOptionalInteger(annotation, "end_index");
  return {
    hashValue: JSON.stringify([url, title ?? null, startIndex ?? null, endIndex ?? null]),
    citation: {
      type: "url",
      url,
      ...(title === undefined ? {} : { title }),
      ...(startIndex === undefined ? {} : { startIndex }),
      ...(endIndex === undefined ? {} : { endIndex }),
    },
  };
}

function updateAnnotationHash(hash: Hash, value: string): void {
  hash.update(Buffer.byteLength(value, "utf8").toString(10), "utf8");
  hash.update(":", "utf8");
  hash.update(value, "utf8");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parsePayload(data: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Responses stream event contains invalid JSON");
  }
  if (!isObject(value)) {
    throw new Error("Responses stream event must contain a JSON object");
  }
  return value;
}

function inferFinishReason(response: Record<string, unknown>): FinishReason {
  if (response.status === "incomplete") {
    const details = isObject(response.incomplete_details) ? response.incomplete_details : undefined;
    return details?.reason === "max_output_tokens" ? "max_tokens" : "incomplete";
  }
  return "end_turn";
}

function decodeUsage(value: unknown): Usage {
  if (!isObject(value)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const inputDetails = isObject(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined;
  const outputDetails = isObject(value.output_tokens_details)
    ? value.output_tokens_details
    : undefined;
  const cacheRead = inputDetails ? readOptionalInteger(inputDetails, "cached_tokens") : undefined;
  const cacheWrite = inputDetails
    ? readOptionalInteger(inputDetails, "cache_write_tokens")
    : undefined;
  const reasoning = outputDetails
    ? readOptionalInteger(outputDetails, "reasoning_tokens")
    : undefined;
  return {
    inputTokens: readOptionalInteger(value, "input_tokens") ?? 0,
    outputTokens: readOptionalInteger(value, "output_tokens") ?? 0,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = value[key];
  if (!isObject(result)) {
    throw new Error(`Responses stream field ${key} must be an object`);
  }
  return result;
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") {
    throw new Error(`Responses stream field ${key} must be a string`);
  }
  return result;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const result = value[key];
  return typeof result === "string" ? result : undefined;
}

function readInteger(value: Record<string, unknown>, key: string): number {
  const result = readOptionalInteger(value, key);
  if (result === undefined) {
    throw new Error(`Responses stream field ${key} must be an integer`);
  }
  return result;
}

function readOptionalInteger(value: Record<string, unknown>, key: string): number | undefined {
  const result = value[key];
  return Number.isSafeInteger(result) && typeof result === "number" ? result : undefined;
}

function assertJsonObject(value: string, label: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must contain complete JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
