export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatFunctionCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatStandardMessage {
  role: "system" | "developer" | "user";
  content: ChatContentPart[];
  name?: string;
}

export interface ChatAssistantMessage {
  role: "assistant";
  content?: ChatContentPart[] | null;
  name?: string;
  refusal?: string;
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
      strict?: boolean | null;
    };
  }>;
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  max_completion_tokens?: number;
  max_tokens?: number;
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  response_format?: ChatResponseFormat;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  safety_identifier?: string;
  service_tier?: "auto" | "default" | "flex" | "priority";
  metadata?: Record<string, string>;
  store?: boolean;
  prompt_cache_key?: string | null;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

export type ChatResponseFormat =
  | { type: "text" | "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        strict?: boolean | null;
        schema: Record<string, unknown>;
      };
    };

export interface ChatMessageOptions {
  name?: string;
  contentNull?: boolean;
  imageDetails?: Array<"auto" | "low" | "high" | undefined>;
}

export interface ChatRequestExtensions {
  message_options?: ChatMessageOptions[];
  tool_strict?: Array<boolean | null | undefined>;
  max_tokens?: number;
  response_format?: ChatResponseFormat;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: ChatRequest["reasoning_effort"];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  safety_identifier?: string;
  service_tier?: ChatRequest["service_tier"];
  metadata?: Record<string, string>;
  store?: boolean;
  prompt_cache_key?: string | null;
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
