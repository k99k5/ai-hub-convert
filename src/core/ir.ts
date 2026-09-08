export type Protocol = "anthropic" | "openai-responses" | "openai-chat";

export interface TextContent {
  type: "text";
  text: string;
  citations?: Citation[];
}

export interface ImageContent {
  type: "image";
  source:
    | { type: "url"; url: string }
    | {
        type: "base64";
        mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
}

export interface ReasoningContent {
  type: "reasoning";
  id?: string;
  text: string;
  signature?: string;
  source: Protocol;
  opaque?: OpaqueContinuation;
}

export interface FunctionCallContent {
  type: "function_call";
  id: string;
  name: string;
  arguments: string;
}

export interface FunctionResultContent {
  type: "function_result";
  callId: string;
  output: string;
  isError: boolean;
}

export interface SearchResultContent {
  type: "search_result";
  title: string;
  source: string;
  content: string;
  citationsEnabled: boolean;
}

export interface RefusalContent {
  type: "refusal";
  refusal: string;
}

export type Content =
  | TextContent
  | ImageContent
  | ReasoningContent
  | FunctionCallContent
  | FunctionResultContent
  | SearchResultContent
  | RefusalContent;

export interface Message {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: Content[];
}

export interface FunctionTool {
  type: "function";
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  strict: boolean;
}

export interface WebSearchTool {
  type: "web_search";
  provider: "web-search";
  maxUses?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  searchContextSize?: "low" | "medium" | "high";
  userLocation?: {
    city?: string;
    country?: string;
    region?: string;
    timezone?: string;
  };
  version:
    | "web_search_20250305"
    | "web_search_20260209"
    | "web_search_20260318"
    | "web_search"
    | "web_search_2025_08_26"
    | "web_search_preview"
    | "web_search_preview_2025_03_11";
}

export type CanonicalTool = FunctionTool | WebSearchTool;

export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "function"; name: string };

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | null;

export interface JsonSchemaOutputFormat {
  type: "json_schema";
  schema: Record<string, unknown>;
}

export interface CanonicalRequest {
  source: Protocol;
  model: string;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  outputFormat?: JsonSchemaOutputFormat;
  messages: Message[];
  tools: CanonicalTool[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;
  metadata?: Record<string, unknown>;
  extensions?: ProviderExtensions;
}

export interface Citation {
  type: "url";
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  webSearchRequests?: number;
}

export type FinishReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "refusal"
  | "incomplete";

export interface CanonicalResponse {
  id: string;
  model: string;
  content: Content[];
  finishReason: FinishReason;
  stopSequence?: string;
  usage: Usage;
  extensions?: ProviderExtensions;
}

export interface OpaqueContinuation {
  provider: Protocol;
  kind: "reasoning" | "signature" | "response";
  value: string;
  synthetic?: boolean;
}

export interface ProviderExtensions {
  source: Protocol;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  structuralHash?: string;
}

export interface RequestContext {
  requestId: string;
  ingress: "anthropic" | "openai-responses";
  apiKey: string;
  claudeCode?: {
    version: string;
    promptCacheBreakpointsEnabled: boolean;
    readToolCompatEnabled: boolean;
    syntheticThinkingSignatureEnabled: boolean;
  };
  signal: AbortSignal;
}
