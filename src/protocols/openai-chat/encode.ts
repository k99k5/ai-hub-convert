import type { CanonicalRequest, Content, Message, ToolChoice } from "../../core/ir.js";
import { withPromptCacheKey } from "../../policies/cache/key.js";
import {
  INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION,
  INTERNAL_WEB_SEARCH_TOOL_NAME,
  INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
} from "../../providers/web-search/internal.js";
import {
  type ChatAssistantMessage,
  type ChatContentPart,
  type ChatFunctionCall,
  type ChatMessage,
  type ChatMessageOptions,
  type ChatRequest,
  type ChatRequestExtensions,
  OpenAIAdapterError,
} from "./types.js";

function imageUrl(content: Extract<Content, { type: "image" }>): string {
  if (content.source.type === "url") {
    return content.source.url;
  }
  return `data:${content.source.mediaType};base64,${content.source.data}`;
}

function encodeContent(
  content: readonly Content[],
  options?: ChatMessageOptions,
): ChatContentPart[] {
  const encoded: ChatContentPart[] = [];
  for (const [index, part] of content.entries()) {
    if (part.type === "text") {
      encoded.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const detail = options?.imageDetails?.[index];
      encoded.push({
        type: "image_url",
        image_url: {
          url: imageUrl(part),
          ...(detail === undefined ? {} : { detail }),
        },
      });
    } else if (part.type === "search_result") {
      encoded.push({ type: "text", text: part.content });
    }
  }
  return encoded;
}

function encodeAssistant(message: Message, options?: ChatMessageOptions): ChatAssistantMessage {
  const reasoning = message.content
    .filter((part): part is Extract<Content, { type: "reasoning" }> => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
  const toolCalls: ChatFunctionCall[] = message.content
    .filter(
      (part): part is Extract<Content, { type: "function_call" }> => part.type === "function_call",
    )
    .map((part) => ({
      id: part.id,
      type: "function" as const,
      function: { name: part.name, arguments: part.arguments },
    }));
  const content = encodeContent(message.content);
  const refusal = message.content
    .filter((part): part is Extract<Content, { type: "refusal" }> => part.type === "refusal")
    .map((part) => part.refusal)
    .join("");
  return {
    role: "assistant",
    ...(content.length === 0 && toolCalls.length > 0 ? {} : { content }),
    ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    ...(refusal.length === 0 ? {} : { refusal }),
    ...(options?.contentNull === true && content.length === 0 ? { content: null } : {}),
    ...(options?.name === undefined ? {} : { name: options.name }),
  };
}

function encodeMessages(
  messages: readonly Message[],
  sameProtocol: boolean,
  options?: ChatMessageOptions[],
): ChatMessage[] {
  const encoded: ChatMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.itemReference !== undefined) {
      throw new OpenAIAdapterError(
        "INVALID_OPENAI_CHAT_REQUEST",
        "Chat 无法转换 Responses 的 item_reference，请发送完整历史内容",
      );
    }
    const messageOptions = options?.[index];
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "function_result") {
          throw new OpenAIAdapterError(
            "INVALID_OPENAI_CHAT_REQUEST",
            "Chat 工具消息只能包含函数调用结果",
          );
        }
        encoded.push({ role: "tool", tool_call_id: part.callId, content: part.output });
      }
    } else if (message.role === "assistant") {
      encoded.push(encodeAssistant(message, messageOptions));
    } else {
      encoded.push({
        role: !sameProtocol && message.role === "developer" ? "system" : message.role,
        content: encodeContent(message.content, messageOptions),
        ...(messageOptions?.name === undefined ? {} : { name: messageOptions.name }),
      });
    }
  }
  return encoded;
}

function hasBuiltInWebSearch(request: CanonicalRequest): boolean {
  return request.tools.some((tool) => tool.type === "web_search");
}

function encodeToolChoice(
  choice: ToolChoice,
  request: CanonicalRequest,
): "auto" | "none" | "required" | { type: "function"; function: { name: string } } {
  if (choice.type === "function") {
    return {
      type: "function",
      function: {
        name:
          choice.name === "web_search" && hasBuiltInWebSearch(request)
            ? INTERNAL_WEB_SEARCH_TOOL_NAME
            : choice.name,
      },
    };
  }
  return choice.type;
}

export function encodeChatRequest(request: CanonicalRequest): ChatRequest {
  const sameProtocol =
    request.source === "openai-chat" && request.extensions?.source === "openai-chat";
  const extensions: ChatRequestExtensions = sameProtocol ? (request.extensions?.request ?? {}) : {};
  const body: ChatRequest = {
    model: request.model,
    messages: encodeMessages(
      request.messages,
      request.source === "openai-chat",
      extensions.message_options,
    ),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool, index) => {
            if (tool.type === "web_search") {
              return {
                type: "function" as const,
                function: {
                  name: INTERNAL_WEB_SEARCH_TOOL_NAME,
                  description: INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION,
                  parameters: INTERNAL_WEB_SEARCH_TOOL_SCHEMA,
                  strict: true,
                },
              };
            }
            return {
              type: "function" as const,
              function: {
                name: tool.name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: tool.inputSchema,
                ...(sameProtocol && extensions.tool_strict !== undefined
                  ? extensions.tool_strict[index] === undefined
                    ? {}
                    : { strict: extensions.tool_strict[index] }
                  : { strict: tool.strict }),
              },
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
      : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.reasoningEffort === undefined ? {} : { reasoning_effort: request.reasoningEffort }),
    ...(request.outputFormat === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: "response",
              strict: true as const,
              schema: request.outputFormat.schema,
            },
          },
        }),
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
  };
  // 仅恢复明确支持的同协议字段，避免扩展覆盖模型、消息或上游流控制。
  if (extensions.max_tokens !== undefined) {
    delete body.max_completion_tokens;
    body.max_tokens = extensions.max_tokens;
  }
  if (extensions.response_format !== undefined) body.response_format = extensions.response_format;
  if (extensions.reasoning_effort !== undefined)
    body.reasoning_effort = extensions.reasoning_effort;
  if (extensions.frequency_penalty !== undefined)
    body.frequency_penalty = extensions.frequency_penalty;
  if (extensions.presence_penalty !== undefined)
    body.presence_penalty = extensions.presence_penalty;
  if (extensions.seed !== undefined) body.seed = extensions.seed;
  if (extensions.logit_bias !== undefined) body.logit_bias = extensions.logit_bias;
  if (extensions.user !== undefined) body.user = extensions.user;
  if (extensions.safety_identifier !== undefined)
    body.safety_identifier = extensions.safety_identifier;
  if (extensions.service_tier !== undefined) body.service_tier = extensions.service_tier;
  if (extensions.metadata !== undefined) body.metadata = extensions.metadata;
  if (extensions.store !== undefined) body.store = extensions.store;
  if (request.extensions?.request?.prompt_cache_key !== undefined) {
    const key = request.extensions.request.prompt_cache_key;
    if (typeof key === "string" || key === null) body.prompt_cache_key = key;
  }
  return withPromptCacheKey("chat/completions", body);
}
