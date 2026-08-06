import type { CanonicalResponse, Citation, Content } from "../../core/ir.js";
import { OpenAIAdapterError } from "./types.js";

const errorCode = "INVALID_OPENAI_RESPONSES_RESPONSE" as const;

type ItemStatus = "in_progress" | "completed" | "incomplete";

interface OutputLayoutItem {
  type: "message" | "reasoning" | "function_call";
  contentCount: number;
  id?: string;
  status?: ItemStatus;
  role?: "assistant";
}

function invalid(message: string): never {
  throw new OpenAIAdapterError(errorCode, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`Invalid canonical Responses metadata: ${label} must be an object`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalid(`Invalid canonical Responses metadata: ${label} must be a string`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`Invalid canonical Responses metadata: ${label} must be a non-negative number`);
  }
  return value;
}

function decodeLayout(value: unknown): OutputLayoutItem[] {
  if (!Array.isArray(value)) {
    return invalid("Invalid canonical Responses metadata: output layout must be an array");
  }
  return value.map((rawItem) => {
    const item = record(rawItem, "output layout item");
    if (item.type !== "message" && item.type !== "reasoning" && item.type !== "function_call") {
      return invalid("Invalid canonical Responses metadata: unsupported output layout type");
    }
    if (!Number.isSafeInteger(item.contentCount) || (item.contentCount as number) < 0) {
      return invalid(
        "Invalid canonical Responses metadata: content count must be a non-negative integer",
      );
    }
    const status = item.status;
    if (
      status !== undefined &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "incomplete"
    ) {
      return invalid("Invalid canonical Responses metadata: invalid output item status");
    }
    if (item.role !== undefined && item.role !== "assistant") {
      return invalid("Invalid canonical Responses metadata: invalid output message role");
    }
    return {
      type: item.type,
      contentCount: item.contentCount as number,
      ...(optionalString(item.id, "output item id") === undefined ? {} : { id: item.id as string }),
      ...(status === undefined ? {} : { status }),
      ...(item.role === undefined ? {} : { role: item.role }),
    };
  });
}

function encodeCitation(citation: Citation): Record<string, unknown> {
  return {
    type: "url_citation",
    url: citation.url,
    ...(citation.title === undefined ? {} : { title: citation.title }),
    ...(citation.startIndex === undefined ? {} : { start_index: citation.startIndex }),
    ...(citation.endIndex === undefined ? {} : { end_index: citation.endIndex }),
  };
}

function encodeMessageContent(content: readonly Content[]): Record<string, unknown>[] {
  return content.map((part) => {
    if (part.type === "text") {
      return {
        type: "output_text",
        text: part.text,
        annotations: part.citations?.map(encodeCitation) ?? [],
      };
    }
    if (part.type === "refusal") {
      return { type: "refusal", refusal: part.refusal };
    }
    return invalid("Invalid canonical Responses content for message output item");
  });
}

function encodeReasoning(content: readonly Content[]): Record<string, unknown> {
  if (content.length !== 1 || content[0]?.type !== "reasoning") {
    return invalid("Invalid canonical Responses content for reasoning output item");
  }
  const reasoning = content[0];
  const encrypted =
    reasoning.source === "openai-responses" &&
    reasoning.opaque?.provider === "openai-responses" &&
    reasoning.opaque.kind === "reasoning" &&
    reasoning.opaque.synthetic !== true
      ? reasoning.opaque.value
      : undefined;
  return {
    summary: [{ type: "summary_text", text: reasoning.text }],
    ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
  };
}

function encodeFunctionCall(content: readonly Content[]): Record<string, unknown> {
  if (content.length !== 1 || content[0]?.type !== "function_call") {
    return invalid("Invalid canonical Responses content for function_call output item");
  }
  return {
    call_id: content[0].id,
    name: content[0].name,
    arguments: content[0].arguments,
  };
}

function encodeOutput(
  content: readonly Content[],
  layout: readonly OutputLayoutItem[],
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  let offset = 0;
  for (const item of layout) {
    const itemContent = content.slice(offset, offset + item.contentCount);
    if (itemContent.length !== item.contentCount) {
      return invalid("Invalid canonical Responses metadata: output layout exceeds content");
    }
    offset += item.contentCount;
    const body =
      item.type === "message"
        ? { content: encodeMessageContent(itemContent) }
        : item.type === "reasoning"
          ? encodeReasoning(itemContent)
          : encodeFunctionCall(itemContent);
    output.push({
      ...(item.id === undefined ? {} : { id: item.id }),
      type: item.type,
      ...(item.type === "message" ? { role: item.role ?? "assistant" } : {}),
      ...(item.status === undefined ? {} : { status: item.status }),
      ...body,
    });
  }
  if (offset !== content.length) {
    return invalid("Invalid canonical Responses metadata: output layout omits content");
  }
  return output;
}

export function encodeResponsesResponse(response: CanonicalResponse): Record<string, unknown> {
  if (response.extensions?.source !== "openai-responses") {
    return invalid("Canonical response does not contain Responses wire metadata");
  }
  const metadata = record(response.extensions.response, "response");
  const status = metadata.status;
  if (status !== "completed" && status !== "incomplete") {
    return invalid("Invalid canonical Responses metadata: unsupported status");
  }
  const usageMetadata = record(metadata.usage, "usage");
  const hasInputDetails = usageMetadata.input_tokens_details_present === true;
  const hasOutputDetails = usageMetadata.output_tokens_details_present === true;
  if (
    usageMetadata.input_tokens_details_present !== undefined &&
    typeof usageMetadata.input_tokens_details_present !== "boolean"
  ) {
    return invalid("Invalid canonical Responses metadata: input token details marker");
  }
  if (
    usageMetadata.output_tokens_details_present !== undefined &&
    typeof usageMetadata.output_tokens_details_present !== "boolean"
  ) {
    return invalid("Invalid canonical Responses metadata: output token details marker");
  }
  const object = optionalString(metadata.object, "object");
  const createdAt = optionalNumber(metadata.created_at, "created_at");
  const totalTokens = optionalNumber(usageMetadata.total_tokens, "total tokens");

  return {
    id: response.id,
    ...(object === undefined ? {} : { object }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    model: response.model,
    status,
    ...(metadata.incomplete_details === undefined
      ? {}
      : { incomplete_details: metadata.incomplete_details }),
    output: encodeOutput(response.content, decodeLayout(metadata.output_layout)),
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
      ...(hasInputDetails
        ? {
            input_tokens_details: {
              ...(response.usage.cacheReadInputTokens === undefined
                ? {}
                : { cached_tokens: response.usage.cacheReadInputTokens }),
              ...(response.usage.cacheWriteInputTokens === undefined
                ? {}
                : { cache_write_tokens: response.usage.cacheWriteInputTokens }),
            },
          }
        : {}),
      ...(hasOutputDetails
        ? {
            output_tokens_details: {
              ...(response.usage.reasoningTokens === undefined
                ? {}
                : { reasoning_tokens: response.usage.reasoningTokens }),
            },
          }
        : {}),
    },
  };
}
