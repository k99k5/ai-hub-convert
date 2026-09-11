import { createHash, type Hash } from "node:crypto";
import type { CanonicalError, CanonicalEvent } from "../../core/events.js";
import type { FinishReason, Usage } from "../../core/ir.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../providers/web-search/internal.js";
import {
  DEFAULT_STREAM_OUTPUT_LIMITS,
  StreamOutputLimiter,
  type StreamOutputLimits,
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
  refusalHash?: Hash;
  messageParts?: Map<number, MessagePart>;
  textLength?: number;
  lastTextIndex?: number;
}

interface MessagePart {
  type: "output_text" | "refusal";
  bodyHash: Hash;
  annotationHash: Hash;
  annotationCount: number;
  textOffset: number;
  done: boolean;
}

interface ParsedMessageBody {
  text: string;
  refusalText: string;
  parts: Array<{
    type: MessagePart["type"];
    text: string;
    annotations: ParsedMessageBody["annotations"];
  }>;
  annotations: Array<{
    hashValue: string;
    citation: Extract<CanonicalEvent, { type: "citation_delta" }>["citation"];
  }>;
}

const OUTPUT_ITEM_OVERHEAD_BYTES = 256;
const CONTENT_PART_OVERHEAD_BYTES = 256;

const IGNORED_EVENTS = new Set([
  "response.in_progress",
  "response.output_text.done",
  "response.refusal.done",
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
    private readonly options: { allowIncompleteToolArguments?: boolean } = {},
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
      case "response.content_part.added":
        return this.#decodePartAdded(payload);
      case "response.content_part.done":
        return this.#decodePartDone(payload);
      case "response.refusal.delta": {
        const index = readInteger(payload, "output_index");
        const item = this.#items.get(index);
        if (item?.type !== "message" || readString(payload, "item_id") !== item.itemId) {
          throw new Error("Responses refusal does not match an open message");
        }
        const contentIndex = readContentIndex(payload);
        const part = this.#getPart(index, item, contentIndex, "refusal");
        const delta = readString(payload, "delta");
        part.bodyHash.update(delta, "utf8");
        item.refusalHash ??= createHash("sha256");
        item.refusalHash.update(delta, "utf8");
        return [];
      }
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
        messageParts: new Map(),
        textLength: 0,
        lastTextIndex: -1,
      };
      streamItem.bodyHash.update(body.text, "utf8");
      this.#items.set(index, streamItem);
      for (const [contentIndex, part] of body.parts.entries()) {
        this.#initializePart(index, streamItem, contentIndex, part);
      }
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
    if (expected === "message") {
      const contentIndex = readContentIndex(payload);
      const part = this.#getPart(index, item, contentIndex, "output_text");
      this.#activateTextPart(item, part, contentIndex);
      part.bodyHash.update(delta, "utf8");
      item.textLength = (item.textLength ?? 0) + delta.length;
    }
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

  #decodePartAdded(payload: Record<string, unknown>): CanonicalEvent[] {
    const { index, item, contentIndex } = this.#readMessagePartTarget(payload);
    const parsed = readMessageBody({ content: [readObject(payload, "part")] }, index).parts[0];
    if (!parsed) throw new Error("Responses 内容块不能为空");
    const part = this.#initializePart(index, item, contentIndex, parsed);
    if (parsed.type === "refusal") return [];
    item.bodyHash.update(parsed.text, "utf8");
    return [
      ...(parsed.text.length === 0
        ? []
        : ([{ type: "text_delta", index, delta: parsed.text }] satisfies CanonicalEvent[])),
      ...parsed.annotations.map(
        ({ citation }): CanonicalEvent => ({
          type: "citation_delta",
          index,
          citation: offsetCitation(citation, part.textOffset),
        }),
      ),
    ];
  }

  #decodePartDone(payload: Record<string, unknown>): CanonicalEvent[] {
    const { index, item, contentIndex } = this.#readMessagePartTarget(payload);
    const part = item.messageParts?.get(contentIndex);
    const parsed = readMessageBody({ content: [readObject(payload, "part")] }, index).parts[0];
    if (!part || part.done || !parsed) throw new Error("Responses 内容块尚未开始或已经结束");
    assertPartMatches(index, part, parsed);
    part.done = true;
    return [];
  }

  #readMessagePartTarget(payload: Record<string, unknown>) {
    this.#assertStarted();
    const index = readInteger(payload, "output_index");
    const item = this.#items.get(index);
    if (
      item?.type !== "message" ||
      (payload.item_id !== undefined && payload.item_id !== item.itemId)
    ) {
      throw new Error("Responses 内容块与当前消息不匹配");
    }
    return { index, item, contentIndex: readContentIndex(payload) };
  }

  #initializePart(
    index: number,
    item: StreamItem,
    contentIndex: number,
    parsed: ParsedMessageBody["parts"][number],
  ): MessagePart {
    const parts = item.messageParts;
    if (!parts || contentIndex !== parts.size) {
      throw new Error("Responses 内容块索引必须从零开始按顺序添加");
    }
    this.#outputLimiter.addBytes(index, CONTENT_PART_OVERHEAD_BYTES);
    const part: MessagePart = {
      type: parsed.type,
      bodyHash: createHash("sha256").update(parsed.text, "utf8"),
      annotationHash: createHash("sha256"),
      annotationCount: parsed.annotations.length,
      textOffset: item.textLength ?? 0,
      done: false,
    };
    for (const annotation of parsed.annotations) {
      updateAnnotationHash(part.annotationHash, annotation.hashValue);
    }
    parts.set(contentIndex, part);
    if (part.type === "output_text") {
      if (parsed.text.length > 0 || parsed.annotations.length > 0) {
        this.#activateTextPart(item, part, contentIndex);
        item.textLength = (item.textLength ?? 0) + parsed.text.length;
      }
    } else {
      item.refusalHash ??= createHash("sha256");
      item.refusalHash.update(parsed.text, "utf8");
    }
    return part;
  }

  #getPart(
    index: number,
    item: StreamItem,
    contentIndex: number,
    type: MessagePart["type"],
  ): MessagePart {
    const part =
      item.messageParts?.get(contentIndex) ??
      this.#initializePart(index, item, contentIndex, { type, text: "", annotations: [] });
    if (part.type !== type || part.done) {
      throw new Error("Responses 内容块类型不匹配或已经结束");
    }
    return part;
  }

  #activateTextPart(item: StreamItem, part: MessagePart, contentIndex: number): void {
    const previous = item.lastTextIndex ?? -1;
    if (contentIndex < previous) {
      throw new Error("Responses 文本增量不能返回已经合并的前置内容块");
    }
    if (contentIndex > previous) {
      part.textOffset = item.textLength ?? 0;
      item.lastTextIndex = contentIndex;
    }
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
    const contentIndex = readContentIndex(payload);
    const part = this.#getPart(index, item, contentIndex, "output_text");
    if (contentIndex >= (item.lastTextIndex ?? -1)) {
      this.#activateTextPart(item, part, contentIndex);
    }
    const annotationIndex = readInteger(payload, "annotation_index");
    if (annotationIndex !== part.annotationCount) {
      throw new Error("Responses message annotations must be emitted in order");
    }
    const annotation = parseAnnotation(readObject(payload, "annotation"));
    updateAnnotationHash(part.annotationHash, annotation.hashValue);
    part.annotationCount++;
    return {
      type: "citation_delta",
      index,
      citation: offsetCitation(annotation.citation, part.textOffset),
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
    const status = readItemStatus(doneItem);
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
    events.push({ type: "content_stop", index, ...(status === undefined ? {} : { status }) });
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
    let message: ParsedMessageBody | undefined;
    if (openItem.type === "message") {
      if (doneItem.role !== "assistant") {
        throw new Error(`Responses output item ${index} done role does not match`);
      }
      message = readMessageBody(doneItem, index);
      if (
        openItem.refusalHash &&
        openItem.refusalHash.digest("hex") !== hashText(message.refusalText)
      ) {
        throw new Error(`Responses output item ${index} done refusal does not match`);
      }
      doneBody = message.text;
      for (const [contentIndex, part] of message.parts.entries()) {
        const tracked = openItem.messageParts?.get(contentIndex);
        if (tracked) {
          assertPartMatches(index, tracked, part);
        } else if (
          part.type === "output_text" &&
          (part.text.length > 0 || part.annotations.length > 0)
        ) {
          throw new Error(`Responses output item ${index} done body does not match`);
        }
      }
      if ((openItem.messageParts?.size ?? 0) > message.parts.length) {
        throw new Error(`Responses output item ${index} done body does not match`);
      }
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
      if (
        doneItem.status !== "incomplete" ||
        this.options.allowIncompleteToolArguments !== true ||
        openItem.name === INTERNAL_WEB_SEARCH_TOOL_NAME
      ) {
        assertJsonObject(doneBody, `Responses output item ${index} arguments`);
      }
    }

    if (openItem.bodyHash.digest("hex") !== hashText(doneBody)) {
      throw new Error(`Responses output item ${index} done body does not match`);
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
  const parts: ParsedMessageBody["parts"] = [];
  const textParts: string[] = [];
  const refusalParts: string[] = [];
  let textOffset = 0;
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
      const parsedAnnotations = partAnnotations.map((value) => parseAnnotationValue(value));
      const text = readString(rawPart, "text");
      annotations.push(
        ...parsedAnnotations.map((annotation) => ({
          ...annotation,
          citation: offsetCitation(annotation.citation, textOffset),
        })),
      );
      parts.push({ type: "output_text", text, annotations: parsedAnnotations });
      textParts.push(text);
      textOffset += text.length;
      continue;
    }
    if (rawPart.type === "refusal") {
      const text = readString(rawPart, "refusal");
      parts.push({ type: "refusal", text, annotations: [] });
      refusalParts.push(text);
      continue;
    }
    throw new Error(`Responses output item ${index} content does not match`);
  }
  return { text: textParts.join(""), refusalText: refusalParts.join(""), annotations, parts };
}

function assertPartMatches(
  index: number,
  tracked: MessagePart,
  part: ParsedMessageBody["parts"][number],
): void {
  if (tracked.type !== part.type || tracked.bodyHash.copy().digest("hex") !== hashText(part.text)) {
    throw new Error(`Responses output item ${index} done body does not match`);
  }
  const annotationHash = createHash("sha256");
  for (const annotation of part.annotations) {
    updateAnnotationHash(annotationHash, annotation.hashValue);
  }
  if (
    tracked.annotationCount !== part.annotations.length ||
    tracked.annotationHash.copy().digest("hex") !== annotationHash.digest("hex")
  ) {
    throw new Error(`Responses output item ${index} done annotations do not match`);
  }
}

function offsetCitation(
  citation: Extract<CanonicalEvent, { type: "citation_delta" }>["citation"],
  offset: number,
): typeof citation {
  return {
    ...citation,
    ...(citation.startIndex === undefined ? {} : { startIndex: citation.startIndex + offset }),
    ...(citation.endIndex === undefined ? {} : { endIndex: citation.endIndex + offset }),
  };
}

function readContentIndex(payload: Record<string, unknown>): number {
  const index = payload.content_index === undefined ? 0 : readInteger(payload, "content_index");
  if (index < 0) throw new Error("Responses 内容块索引不能为负数");
  return index;
}

function readItemStatus(
  item: Record<string, unknown>,
): Extract<CanonicalEvent, { type: "content_stop" }>["status"] {
  const status = item.status;
  if (
    status === undefined ||
    status === "completed" ||
    status === "in_progress" ||
    status === "incomplete"
  ) {
    return status;
  }
  throw new Error("Responses 输出项状态无效");
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
