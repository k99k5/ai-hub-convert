import type { CanonicalRequest, Content, Message, ToolChoice } from "../../core/ir.js";
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
  type ChatRequest,
  OpenAIAdapterError,
} from "./types.js";

function imageUrl(content: Extract<Content, { type: "image" }>): string {
  if (content.source.type === "url") {
    return content.source.url;
  }
  return `data:${content.source.mediaType};base64,${content.source.data}`;
}

function encodeContent(content: readonly Content[]): ChatContentPart[] {
  const encoded: ChatContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      encoded.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      encoded.push({ type: "image_url", image_url: { url: imageUrl(part) } });
    } else if (part.type === "search_result") {
      encoded.push({ type: "text", text: part.content });
    }
  }
  return encoded;
}

function encodeAssistant(message: Message): ChatAssistantMessage {
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
  return {
    role: "assistant",
    ...(content.length === 0 && toolCalls.length > 0 ? {} : { content }),
    ...(reasoning.length === 0 ? {} : { reasoning_content: reasoning }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function encodeMessages(messages: readonly Message[]): ChatMessage[] {
  const encoded: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "function_result") {
          throw new OpenAIAdapterError(
            "INVALID_OPENAI_CHAT_REQUEST",
            "Chat tool messages may contain only function results",
          );
        }
        encoded.push({ role: "tool", tool_call_id: part.callId, content: part.output });
      }
    } else if (message.role === "assistant") {
      encoded.push(encodeAssistant(message));
    } else {
      encoded.push({
        role: message.role === "developer" ? "system" : message.role,
        content: encodeContent(message.content),
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
  return {
    model: request.model,
    messages: encodeMessages(request.messages),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => {
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
                strict: tool.strict,
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
    stream: request.stream,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
  };
}
