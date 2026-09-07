export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicBase64ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: AnthropicImageMediaType;
    data: string;
  };
}

export interface AnthropicUrlImageBlock {
  type: "image";
  source: {
    type: "url";
    url: string;
  };
}

export type AnthropicImageBlock = AnthropicBase64ImageBlock | AnthropicUrlImageBlock;

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicSearchResultBlock {
  type: "search_result";
  title: string;
  source: string;
  content: AnthropicTextBlock[];
  citations?: { enabled?: boolean };
}

export type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicSearchResultBlock;

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicToolResultContentBlock[];
  is_error?: boolean;
}

export type AnthropicRequestContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicSearchResultBlock;

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | AnthropicRequestContentBlock[];
}

export interface AnthropicCustomTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
  type?: "custom";
}

export interface AnthropicWebSearchTool {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: Record<string, unknown>;
}

export type AnthropicTool = AnthropicCustomTool | AnthropicWebSearchTool;

export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "none" }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export type AnthropicReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | null;

export interface AnthropicOutputConfig {
  effort?: AnthropicReasoningEffort;
  format?: null;
}

export type AnthropicThinkingConfig =
  | { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" | null }
  | { type: "disabled" }
  | { type: "adaptive"; display?: "summarized" | "omitted" | null };

export interface AnthropicMetadata {
  user_id?: string | null;
  [key: string]: unknown;
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  output_config?: AnthropicOutputConfig;
  thinking?: AnthropicThinkingConfig;
  metadata?: AnthropicMetadata;
}

export interface AnthropicUrlCitation {
  type: "web_search_result_location";
  url: string;
  title: string | null;
  cited_text: string;
  encrypted_index: string;
}

export interface AnthropicResponseTextBlock {
  type: "text";
  text: string;
  citations?: AnthropicUrlCitation[];
}

export interface AnthropicResponseToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicResponseThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicResponseSearchResultBlock {
  type: "search_result";
  title: string;
  source: string;
  content: AnthropicTextBlock[];
  citations: { enabled: boolean };
}

export interface AnthropicResponseServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: "web_search";
  input: { query: string };
}

export interface AnthropicResponseWebSearchResult {
  type: "web_search_result";
  title: string;
  url: string;
}

export interface AnthropicResponseWebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: AnthropicResponseWebSearchResult[];
}

export type AnthropicResponseContentBlock =
  | AnthropicResponseTextBlock
  | AnthropicImageBlock
  | AnthropicResponseToolUseBlock
  | AnthropicResponseThinkingBlock
  | AnthropicResponseSearchResultBlock
  | AnthropicResponseServerToolUseBlock
  | AnthropicResponseWebSearchToolResultBlock;

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "refusal"
  | "pause_turn";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: {
    web_search_requests: number;
  };
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: AnthropicStopReason;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}
