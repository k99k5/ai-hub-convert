export type ResponsesInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; detail: "auto"; image_url: string };

export interface ResponsesMessageItem {
  type: "message";
  role: "system" | "developer" | "user" | "assistant";
  content: ResponsesInputContent[];
}

export interface ResponsesReasoningItem {
  id: string;
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
  encrypted_content?: string;
}

export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionResultItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesReasoningItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionResultItem;

export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export type ResponsesToolChoice = "auto" | "none" | "required" | { type: "function"; name: string };

export interface ResponsesRequest {
  include?: Array<"reasoning.encrypted_content">;
  model: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
  tool_choice?: ResponsesToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
  store: boolean | null;
  previous_response_id?: string | null;
  reasoning?: Record<string, unknown> | null;
  text?: {
    format: {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict: true;
    };
  };
  prompt_cache_key?: string | null;
}

export type ResponsesAdapterErrorCode =
  | "REFERENCE_CACHE_MISS"
  | "INVALID_OPENAI_RESPONSES_REQUEST"
  | "INVALID_OPENAI_RESPONSES_RESPONSE";

export class OpenAIAdapterError extends Error {
  readonly code: ResponsesAdapterErrorCode;

  constructor(code: ResponsesAdapterErrorCode, message: string) {
    super(message);
    this.name = "OpenAIAdapterError";
    this.code = code;
  }
}
