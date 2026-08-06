import type { CanonicalResponse, Citation, Content, FinishReason, Usage } from "../../core/ir.js";
import { OpenAIAdapterError } from "./types.js";

export interface DecodeResponsesResponseOptions {
  preserveWireMetadata?: boolean;
}

interface OutputLayoutItem {
  type: "message" | "reasoning" | "function_call";
  contentCount: number;
  id?: string;
  status?: "in_progress" | "completed" | "incomplete";
  role?: "assistant";
}

interface DecodedOutput {
  content: Content[];
  layout: OutputLayoutItem[];
}

const errorCode = "INVALID_OPENAI_RESPONSES_RESPONSE" as const;

function invalid(message: string): never {
  throw new OpenAIAdapterError(errorCode, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`Invalid OpenAI Responses response: ${label} must be an object`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    invalid(`Invalid OpenAI Responses response: ${label} must be a string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`Invalid OpenAI Responses response: ${label} must be a non-negative number`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(`Invalid OpenAI Responses response: ${label} must be an array`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : number(value, label);
}

function decodeCitation(value: unknown): Citation | undefined {
  const annotation = record(value, "output_text annotation");
  if (annotation.type !== "url_citation") {
    return undefined;
  }
  const title =
    annotation.title === undefined ? undefined : string(annotation.title, "citation title");
  const startIndex = optionalNumber(annotation.start_index, "citation start_index");
  const endIndex = optionalNumber(annotation.end_index, "citation end_index");
  return {
    type: "url",
    url: string(annotation.url, "citation url"),
    ...(title === undefined ? {} : { title }),
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(endIndex === undefined ? {} : { endIndex }),
  };
}

function decodeMessage(item: Record<string, unknown>): Content[] {
  const result: Content[] = [];
  for (const rawPart of array(item.content, "message content")) {
    const part = record(rawPart, "message content item");
    if (part.type === "output_text") {
      const rawAnnotations =
        part.annotations === undefined ? [] : array(part.annotations, "annotations");
      const citations = rawAnnotations
        .map(decodeCitation)
        .filter((citation): citation is Citation => citation !== undefined);
      result.push({
        type: "text",
        text: string(part.text, "output_text text"),
        ...(citations.length === 0 ? {} : { citations }),
      });
    } else if (part.type === "refusal") {
      result.push({
        type: "refusal",
        refusal: string(part.refusal, "refusal text"),
      });
    } else {
      invalid("Unsupported OpenAI Responses message content");
    }
  }
  return result;
}

function decodeReasoning(item: Record<string, unknown>): Content {
  const id = string(item.id, "reasoning id");
  const summary = array(item.summary, "reasoning summary");
  const text = summary
    .map((rawPart) => {
      const part = record(rawPart, "reasoning summary item");
      if (part.type !== "summary_text") {
        invalid("Invalid OpenAI Responses response: unexpected reasoning summary type");
      }
      return string(part.text, "reasoning summary text");
    })
    .join("");
  const encrypted =
    item.encrypted_content === undefined || item.encrypted_content === null
      ? undefined
      : string(item.encrypted_content, "reasoning encrypted_content");
  return {
    type: "reasoning",
    id,
    text,
    source: "openai-responses",
    ...(encrypted === undefined
      ? {}
      : {
          opaque: {
            provider: "openai-responses" as const,
            kind: "reasoning" as const,
            value: encrypted,
          },
        }),
  };
}

function decodeOutput(value: unknown): DecodedOutput {
  const content: Content[] = [];
  const layout: OutputLayoutItem[] = [];
  for (const rawItem of array(value, "output")) {
    const item = record(rawItem, "output item");
    const start = content.length;
    if (item.type === "message") {
      content.push(...decodeMessage(item));
    } else if (item.type === "reasoning") {
      content.push(decodeReasoning(item));
    } else if (item.type === "function_call") {
      content.push({
        type: "function_call",
        id: string(item.call_id, "function call_id"),
        name: string(item.name, "function name"),
        arguments: string(item.arguments, "function arguments"),
      });
    } else {
      invalid("Unsupported OpenAI Responses output item");
    }
    const id = item.id === undefined ? undefined : string(item.id, "output item id");
    const status = decodeItemStatus(item.status);
    const role = item.type === "message" ? decodeMessageRole(item.role) : undefined;
    layout.push({
      type: item.type,
      contentCount: content.length - start,
      ...(id === undefined ? {} : { id }),
      ...(status === undefined ? {} : { status }),
      ...(role === undefined ? {} : { role }),
    });
  }
  return { content, layout };
}

function decodeItemStatus(value: unknown): "in_progress" | "completed" | "incomplete" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "in_progress" && value !== "completed" && value !== "incomplete") {
    return invalid("Invalid OpenAI Responses response: invalid output item status");
  }
  return value;
}

function decodeMessageRole(value: unknown): "assistant" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "assistant") {
    return invalid("Invalid OpenAI Responses response: invalid output message role");
  }
  return value;
}

function decodeUsage(value: unknown): Usage {
  const rawUsage = record(value, "usage");
  const inputDetails =
    rawUsage.input_tokens_details === undefined
      ? undefined
      : record(rawUsage.input_tokens_details, "input token details");
  const outputDetails =
    rawUsage.output_tokens_details === undefined
      ? undefined
      : record(rawUsage.output_tokens_details, "output token details");
  const cacheRead =
    inputDetails === undefined
      ? undefined
      : optionalNumber(inputDetails.cached_tokens, "cached tokens");
  const cacheWrite =
    inputDetails === undefined
      ? undefined
      : optionalNumber(inputDetails.cache_write_tokens, "cache write tokens");
  const reasoning =
    outputDetails === undefined
      ? undefined
      : optionalNumber(outputDetails.reasoning_tokens, "reasoning tokens");
  return {
    inputTokens: number(rawUsage.input_tokens, "input tokens"),
    outputTokens: number(rawUsage.output_tokens, "output tokens"),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

function finishReason(body: Record<string, unknown>, content: readonly Content[]): FinishReason {
  if (body.status === "incomplete") {
    const details =
      body.incomplete_details === undefined || body.incomplete_details === null
        ? undefined
        : record(body.incomplete_details, "incomplete_details");
    return details?.reason === "max_output_tokens" ? "max_tokens" : "incomplete";
  }
  if (body.status !== "completed") {
    return "incomplete";
  }
  if (content.some((part) => part.type === "function_call")) {
    return "tool_use";
  }
  if (content.some((part) => part.type === "refusal")) {
    return "refusal";
  }
  return "end_turn";
}

export function decodeResponsesResponse(
  input: unknown,
  options: DecodeResponsesResponseOptions = {},
): CanonicalResponse {
  const body = record(input, "body");
  const output = decodeOutput(body.output);
  const usage = decodeUsage(body.usage);
  return {
    id: string(body.id, "id"),
    model: string(body.model, "model"),
    content: output.content,
    finishReason: finishReason(body, output.content),
    usage,
    ...(options.preserveWireMetadata
      ? {
          extensions: {
            source: "openai-responses",
            response: decodeWireMetadata(body, output.layout, usage),
          },
        }
      : {}),
  };
}

function decodeIncompleteDetails(value: unknown): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const details = record(value, "incomplete_details");
  const reason = details.reason;
  if (reason !== "max_output_tokens" && reason !== "content_filter") {
    invalid("Invalid OpenAI Responses response: unsupported incomplete reason");
  }
  return { reason };
}

function decodeWireMetadata(
  body: Record<string, unknown>,
  layout: readonly OutputLayoutItem[],
  usage: Usage,
): Record<string, unknown> {
  const object = body.object === undefined ? undefined : string(body.object, "object");
  if (object !== undefined && object !== "response") {
    invalid("Invalid OpenAI Responses response: invalid object type");
  }
  const createdAt = optionalNumber(body.created_at, "created_at");
  const status = body.status;
  if (status !== "completed" && status !== "incomplete") {
    invalid("Invalid OpenAI Responses response: unsupported terminal status");
  }
  const rawUsage = record(body.usage, "usage");
  const totalTokens = optionalNumber(rawUsage.total_tokens, "total tokens");
  return {
    ...(object === undefined ? {} : { object }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    status,
    ...(body.incomplete_details === undefined
      ? {}
      : { incomplete_details: decodeIncompleteDetails(body.incomplete_details) }),
    output_layout: layout,
    usage: {
      ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
      input_tokens_details_present: rawUsage.input_tokens_details !== undefined,
      output_tokens_details_present: rawUsage.output_tokens_details !== undefined,
      canonical_input_tokens: usage.inputTokens,
      canonical_output_tokens: usage.outputTokens,
    },
  };
}
