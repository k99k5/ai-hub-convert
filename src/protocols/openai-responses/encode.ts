import type { CanonicalRequest, Content, Message, ToolChoice } from "../../core/ir.js";
import type { PromptCacheCapability } from "../../policies/cache/capabilities.js";
import {
  INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION,
  INTERNAL_WEB_SEARCH_TOOL_NAME,
  INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
} from "../../providers/web-search/internal.js";
import {
  OpenAIAdapterError,
  type ResponsesInputContent,
  type ResponsesInputItem,
  type ResponsesRequest,
  type ResponsesToolChoice,
} from "./types.js";

export interface EncodeResponsesOptions {
  store: boolean;
  promptCache: PromptCacheCapability;
  promptCacheKey?: string;
  replaySourceExtensions?: boolean;
}

function imageUrl(content: Extract<Content, { type: "image" }>): string {
  if (content.source.type === "url") {
    return content.source.url;
  }
  return `data:${content.source.mediaType};base64,${content.source.data}`;
}

function encodeMessageContent(content: readonly Content[]): ResponsesInputContent[] {
  const encoded: ResponsesInputContent[] = [];
  for (const part of content) {
    if (part.type === "text") {
      encoded.push({ type: "input_text", text: part.text });
    } else if (part.type === "image") {
      encoded.push({ type: "input_image", detail: "auto", image_url: imageUrl(part) });
    }
  }
  return encoded;
}

function replayableReasoning(
  content: Extract<Content, { type: "reasoning" }>,
): { id: string; encryptedContent?: string } | undefined {
  if (content.source !== "openai-responses" || content.id === undefined) {
    return undefined;
  }
  const opaque = content.opaque;
  const encryptedContent =
    opaque?.provider === "openai-responses" &&
    opaque.kind === "reasoning" &&
    opaque.synthetic !== true
      ? opaque.value
      : undefined;
  return {
    id: content.id,
    ...(encryptedContent === undefined ? {} : { encryptedContent }),
  };
}

function encodeMessage(message: Message): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  const messageContent = encodeMessageContent(message.content);
  if (messageContent.length > 0) {
    if (message.role === "tool") {
      throw new OpenAIAdapterError(
        "INVALID_OPENAI_RESPONSES_REQUEST",
        "Responses tool messages may contain only function results",
      );
    }
    items.push({ type: "message", role: message.role, content: messageContent });
  } else if (message.role === "assistant" && message.content.length === 0) {
    items.push({ type: "message", role: "assistant", content: [] });
  }

  for (const part of message.content) {
    if (part.type === "reasoning") {
      const replay = replayableReasoning(part);
      if (replay !== undefined) {
        items.push({
          id: replay.id,
          type: "reasoning",
          summary: [{ type: "summary_text", text: part.text }],
          ...(replay.encryptedContent === undefined
            ? {}
            : { encrypted_content: replay.encryptedContent }),
        });
      }
    } else if (part.type === "function_call") {
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: part.arguments,
      });
    } else if (part.type === "function_result") {
      items.push({
        type: "function_call_output",
        call_id: part.callId,
        output: part.output,
      });
    } else if (part.type === "refusal") {
      if (message.role === "tool") {
        throw new OpenAIAdapterError(
          "INVALID_OPENAI_RESPONSES_REQUEST",
          "Responses tool messages may contain only function results",
        );
      }
      items.push({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: part.refusal }],
      });
    } else if (part.type === "search_result") {
      if (message.role === "tool") {
        throw new OpenAIAdapterError(
          "INVALID_OPENAI_RESPONSES_REQUEST",
          "Responses tool messages may contain only function results",
        );
      }
      items.push({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: part.content }],
      });
    }
  }
  return items;
}

function hasBuiltInWebSearch(request: CanonicalRequest): boolean {
  return request.tools.some((tool) => tool.type === "web_search");
}

function encodeToolChoice(choice: ToolChoice, request: CanonicalRequest): ResponsesToolChoice {
  if (choice.type === "function") {
    return {
      type: "function",
      name:
        request.source !== "openai-responses" &&
        choice.name === "web_search" &&
        hasBuiltInWebSearch(request)
          ? INTERNAL_WEB_SEARCH_TOOL_NAME
          : choice.name,
    };
  }
  return choice.type;
}

export function encodeResponsesRequest(
  request: CanonicalRequest,
  options: EncodeResponsesOptions,
): ResponsesRequest {
  const input = request.messages.flatMap(encodeMessage);
  const extensions =
    options.replaySourceExtensions && request.extensions?.source === "openai-responses"
      ? request.extensions.request
      : undefined;
  const extensionStore = extensions?.store;
  const store =
    extensionStore === null || typeof extensionStore === "boolean" ? extensionStore : options.store;
  const previousResponseId = extensions?.previous_response_id;
  const extensionReasoning = extensions?.reasoning;
  const reasoning =
    request.reasoningEffort === undefined
      ? extensionReasoning
      : typeof extensionReasoning === "object" &&
          extensionReasoning !== null &&
          !Array.isArray(extensionReasoning)
        ? { ...extensionReasoning, effort: request.reasoningEffort }
        : { effort: request.reasoningEffort };
  const extensionPromptCacheKey = extensions?.prompt_cache_key;
  return {
    model: request.model,
    input,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => {
            if (tool.type === "web_search") {
              return {
                type: "function" as const,
                name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                description:
                  INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION +
                  (request.source === "openai-responses"
                    ? " 请在答案中以 Markdown 链接引用实际使用的搜索结果，链接必须来自工具返回的 URL。" +
                      (tool.userLocation === undefined
                        ? ""
                        : ` 用户近似位置和时区：${JSON.stringify(tool.userLocation)}。`)
                    : ""),
                parameters: INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
                strict: true,
              };
            }
            return {
              type: "function" as const,
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.inputSchema,
              strict: tool.strict,
            };
          }),
        }),
    ...(request.toolChoice === undefined
      ? {}
      : { tool_choice: encodeToolChoice(request.toolChoice, request) }),
    ...(request.parallelToolCalls === undefined
      ? {}
      : { parallel_tool_calls: request.parallelToolCalls }),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens }),
    stream: request.stream,
    ...(Array.isArray(extensions?.include) &&
    extensions.include.includes("reasoning.encrypted_content")
      ? { include: ["reasoning.encrypted_content" as const] }
      : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    store,
    ...(typeof previousResponseId === "string" || previousResponseId === null
      ? { previous_response_id: previousResponseId }
      : {}),
    ...(reasoning === null || (typeof reasoning === "object" && !Array.isArray(reasoning))
      ? { reasoning: reasoning as Record<string, unknown> | null }
      : {}),
    ...(request.outputFormat === undefined
      ? {}
      : {
          text: {
            format: {
              type: "json_schema" as const,
              name: "response",
              schema: request.outputFormat.schema,
              strict: true as const,
            },
          },
        }),
    ...(options.promptCache.kind === "prompt-cache-key"
      ? options.promptCacheKey !== undefined
        ? { prompt_cache_key: options.promptCacheKey }
        : typeof extensionPromptCacheKey === "string" || extensionPromptCacheKey === null
          ? { prompt_cache_key: extensionPromptCacheKey }
          : {}
      : {}),
  };
}
