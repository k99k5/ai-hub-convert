import type { CanonicalRequest, Content, Message, ToolChoice } from "../../core/ir.js";
import type { PromptCacheCapability } from "../../policies/cache/capabilities.js";
import { withPromptCacheKey } from "../../policies/cache/key.js";
import {
  INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION,
  INTERNAL_WEB_SEARCH_TOOL_NAME,
  INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
} from "../../providers/web-search/internal.js";
import { encodeToolResultOutput } from "../tool-result.js";
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
  promptCacheKey?: string | null;
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
      encoded.push({
        type: "input_image",
        detail: part.detail ?? "auto",
        image_url: imageUrl(part),
      });
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
  const role = message.role;
  if (role === "tool") {
    return message.content.map((part) => {
      if (part.type !== "function_result") {
        throw new OpenAIAdapterError(
          "INVALID_OPENAI_RESPONSES_REQUEST",
          "Responses 工具消息只能包含函数结果",
        );
      }
      return {
        type: "function_call_output",
        call_id: part.callId,
        output: encodeToolResultOutput(part),
      };
    });
  }
  if (message.role === "assistant" && message.content.length === 0) {
    items.push({ type: "message", role: "assistant", content: [] });
  }
  let pending: Content[] = [];
  const flushText = (): void => {
    if (pending.length === 0) return;
    items.push({ type: "message", role, content: encodeMessageContent(pending) });
    pending = [];
  };

  for (const part of message.content) {
    if (part.type === "text" || part.type === "image") {
      pending.push(part);
    } else if (part.type === "reasoning") {
      const replay = replayableReasoning(part);
      if (replay !== undefined) {
        flushText();
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
      flushText();
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: part.arguments,
      });
    } else if (part.type === "function_result") {
      flushText();
      items.push({
        type: "function_call_output",
        call_id: part.callId,
        output: encodeToolResultOutput(part),
      });
    } else if (part.type === "refusal") {
      flushText();
      items.push({
        type: "message",
        role,
        content: [{ type: "input_text", text: part.refusal }],
      });
    } else if (part.type === "search_result") {
      flushText();
      items.push({
        type: "message",
        role,
        content: [{ type: "input_text", text: part.content }],
      });
    }
  }
  flushText();
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
  const input = request.messages.flatMap((message): ResponsesInputItem[] => {
    if (message.itemReference !== undefined) {
      throw new OpenAIAdapterError(
        "INVALID_OPENAI_RESPONSES_REQUEST",
        "item_reference 必须在网关展开后才能请求上游",
      );
    }
    return encodeMessage(message);
  });
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
  // 缓存键是三个入口共用的已验证字段，不重放其他跨协议扩展。
  const extensionPromptCacheKey = request.extensions?.request?.prompt_cache_key;
  const body: ResponsesRequest = {
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
                    ? " 请在答案中以 Markdown 链接引用实际使用的搜索结果，链接必须来自工具返回的 URL。"
                    : "") +
                  (tool.userLocation === undefined
                    ? ""
                    : ` 用户近似位置和时区：${JSON.stringify(tool.userLocation)}。`),
                parameters: INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
                strict: true,
              };
            }
            return {
              type: "function" as const,
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.inputSchema,
              ...(tool.strict === undefined ? {} : { strict: tool.strict }),
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
    ...(extensions?.text !== undefined
      ? { text: extensions.text as NonNullable<ResponsesRequest["text"]> }
      : request.outputFormat === undefined
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
  return options.promptCache.kind === "prompt-cache-key"
    ? withPromptCacheKey("responses", body)
    : body;
}
