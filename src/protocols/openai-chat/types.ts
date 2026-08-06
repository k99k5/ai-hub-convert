export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatFunctionCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatStandardMessage {
  role: "system" | "user";
  content: ChatContentPart[];
}

export interface ChatAssistantMessage {
  role: "assistant";
  content?: ChatContentPart[];
  reasoning_content?: string;
  tool_calls?: ChatFunctionCall[];
}

export interface ChatToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage = ChatStandardMessage | ChatAssistantMessage | ChatToolMessage;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
      strict: boolean;
    };
  }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

export class OpenAIAdapterError extends Error {
  readonly code: "INVALID_OPENAI_CHAT_REQUEST" | "INVALID_OPENAI_CHAT_RESPONSE";

  constructor(
    code: "INVALID_OPENAI_CHAT_REQUEST" | "INVALID_OPENAI_CHAT_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "OpenAIAdapterError";
    this.code = code;
  }
}
