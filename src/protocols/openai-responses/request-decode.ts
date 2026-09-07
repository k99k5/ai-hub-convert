import type {
  CanonicalRequest,
  CanonicalTool,
  Content,
  Message,
  ToolChoice,
} from "../../core/ir.js";
import { OpenAIAdapterError } from "./types.js";

const errorCode = "INVALID_OPENAI_RESPONSES_REQUEST" as const;
const supportedTopLevelFields = new Set([
  "background",
  "input",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
]);

function invalid(message: string): never {
  throw new OpenAIAdapterError(errorCode, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    invalid(`Invalid OpenAI Responses request: ${label} must be an object`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`Invalid OpenAI Responses request: ${label} must be a non-empty string`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalid(`Invalid OpenAI Responses request: ${label} must be a finite number`);
  }
  return value;
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  const result = record(value, label);
  if (!isJsonValue(result)) {
    invalid(`Invalid OpenAI Responses request: ${label} must contain JSON values`);
  }
  return result;
}

function isJsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 100) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors, depth + 1))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function decodeImage(value: unknown): Content {
  const imageUrl = string(value, "input_image image_url");
  const dataUrl = imageUrl.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/s);
  if (dataUrl?.[1] && dataUrl[2] !== undefined) {
    return {
      type: "image",
      source: {
        type: "base64",
        mediaType: dataUrl[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: dataUrl[2],
      },
    };
  }
  if (imageUrl.startsWith("data:")) {
    return invalid("Unsupported OpenAI Responses input image media type");
  }
  return { type: "image", source: { type: "url", url: imageUrl } };
}

function decodeMessageContent(value: unknown, role: Message["role"]): Content[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value }];
  }
  if (!Array.isArray(value)) {
    return invalid("Unsupported OpenAI Responses input");
  }
  return value.map((rawPart) => {
    const part = record(rawPart, "message content item");
    if (part.type === "input_text" || (role === "assistant" && part.type === "output_text")) {
      if (typeof part.text !== "string") {
        return invalid("Invalid OpenAI Responses request: input_text text must be a string");
      }
      return { type: "text" as const, text: part.text };
    }
    if (role === "assistant" && part.type === "refusal" && typeof part.refusal === "string") {
      return { type: "refusal" as const, refusal: part.refusal };
    }
    if (part.type === "input_image" && part.file_id === undefined) {
      return decodeImage(part.image_url);
    }
    return invalid("Unsupported OpenAI Responses input");
  });
}

function decodeMessage(item: Record<string, unknown>): Message {
  const role = item.role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant") {
    return invalid("Invalid OpenAI Responses request: unsupported message role");
  }
  return { role, content: decodeMessageContent(item.content, role) };
}

function decodeReasoning(item: Record<string, unknown>): Message {
  const id = string(item.id, "reasoning id");
  if (!Array.isArray(item.summary)) {
    return invalid("Invalid OpenAI Responses request: reasoning summary must be an array");
  }
  const text = item.summary
    .map((rawPart) => {
      const part = record(rawPart, "reasoning summary item");
      if (part.type !== "summary_text" || typeof part.text !== "string") {
        return invalid("Unsupported OpenAI Responses input");
      }
      return part.text;
    })
    .join("");
  const encrypted = item.encrypted_content;
  if (encrypted !== undefined && encrypted !== null && typeof encrypted !== "string") {
    return invalid("Invalid OpenAI Responses request: encrypted_content must be a string");
  }
  return {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        id,
        text,
        source: "openai-responses",
        ...(typeof encrypted === "string"
          ? {
              opaque: {
                provider: "openai-responses" as const,
                kind: "reasoning" as const,
                value: encrypted,
              },
            }
          : {}),
      },
    ],
  };
}

function decodeFunctionCall(item: Record<string, unknown>): Message {
  const argumentsJson = string(item.arguments, "function_call arguments");
  try {
    JSON.parse(argumentsJson);
  } catch {
    return invalid("Invalid OpenAI Responses request: function_call arguments must be JSON");
  }
  return {
    role: "assistant",
    content: [
      {
        type: "function_call",
        id: string(item.call_id, "function_call call_id"),
        name: string(item.name, "function_call name"),
        arguments: argumentsJson,
      },
    ],
  };
}

function decodeFunctionResult(item: Record<string, unknown>): Message {
  if (typeof item.output !== "string") {
    return invalid("Unsupported OpenAI Responses input");
  }
  return {
    role: "tool",
    content: [
      {
        type: "function_result",
        callId: string(item.call_id, "function_call_output call_id"),
        output: item.output,
        isError: false,
      },
    ],
  };
}

function decodeInput(value: unknown): Message[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return [{ role: "user", content: [{ type: "text", text: value }] }];
  }
  if (!Array.isArray(value)) {
    return invalid("Unsupported OpenAI Responses input");
  }
  return value.map((rawItem) => {
    const item = record(rawItem, "input item");
    if (item.type === undefined || item.type === "message") {
      return decodeMessage(item);
    }
    if (item.type === "reasoning") {
      return decodeReasoning(item);
    }
    if (item.type === "function_call") {
      return decodeFunctionCall(item);
    }
    if (item.type === "function_call_output") {
      return decodeFunctionResult(item);
    }
    return invalid("Unsupported OpenAI Responses input");
  });
}

function validateWebSearchLocation(value: unknown, preview: boolean): void {
  if (value === undefined || value === null) {
    return;
  }
  if (
    !isRecord(value) ||
    (preview
      ? value.type !== "approximate"
      : value.type !== undefined && value.type !== "approximate")
  ) {
    invalid("Invalid OpenAI Responses request: invalid Web Search user location");
  }
  for (const key of ["city", "country", "region", "timezone"]) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      invalid("Invalid OpenAI Responses request: invalid Web Search user location");
    }
  }
}

function validateWebSearchTool(tool: Record<string, unknown>, preview: boolean): void {
  if (
    tool.search_context_size !== undefined &&
    tool.search_context_size !== "low" &&
    tool.search_context_size !== "medium" &&
    tool.search_context_size !== "high"
  ) {
    invalid("Invalid OpenAI Responses request: invalid Web Search context size");
  }
  if (preview && tool.filters !== undefined) {
    invalid("Invalid OpenAI Responses request: preview Web Search does not support filters");
  }
  if (!preview && tool.filters !== undefined && tool.filters !== null) {
    if (!isRecord(tool.filters)) {
      invalid("Invalid OpenAI Responses request: invalid Web Search filters");
    }
    const allowedDomains = tool.filters.allowed_domains;
    if (
      allowedDomains !== undefined &&
      allowedDomains !== null &&
      (!Array.isArray(allowedDomains) ||
        !allowedDomains.every((domain) => typeof domain === "string"))
    ) {
      invalid("Invalid OpenAI Responses request: invalid Web Search filters");
    }
  }
  if (!preview && tool.search_content_types !== undefined) {
    invalid("Invalid OpenAI Responses request: Web Search does not support search content types");
  }
  if (
    preview &&
    tool.search_content_types !== undefined &&
    (!Array.isArray(tool.search_content_types) ||
      !tool.search_content_types.every(
        (contentType) => contentType === "text" || contentType === "image",
      ))
  ) {
    invalid("Invalid OpenAI Responses request: invalid Web Search content types");
  }
  validateWebSearchLocation(tool.user_location, preview);
}

function decodeTools(value: unknown): CanonicalTool[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalid("Invalid OpenAI Responses request: tools must be an array");
  }
  return value.map((rawTool) => {
    const tool = record(rawTool, "tool");
    if (
      tool.type === "web_search" ||
      tool.type === "web_search_2025_08_26" ||
      tool.type === "web_search_preview" ||
      tool.type === "web_search_preview_2025_03_11"
    ) {
      validateWebSearchTool(tool, tool.type.startsWith("web_search_preview"));
      return {
        type: "web_search" as const,
        provider: "web-search" as const,
        version: tool.type,
        ...(isRecord(tool.filters) && Array.isArray(tool.filters.allowed_domains)
          ? { allowedDomains: [...tool.filters.allowed_domains] as string[] }
          : {}),
      };
    }
    if (tool.type !== "function") {
      return invalid("Unsupported OpenAI Responses tool");
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      return invalid("Invalid OpenAI Responses request: tool description must be a string");
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      return invalid("Invalid OpenAI Responses request: tool strict must be a boolean");
    }
    return {
      type: "function" as const,
      name: string(tool.name, "tool name"),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: jsonRecord(tool.parameters, "tool parameters"),
      strict: tool.strict ?? false,
    };
  });
}

function decodeToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "auto" || value === "none" || value === "required") {
    return { type: value };
  }
  const choice = record(value, "tool_choice");
  if (choice.type !== "function") {
    return invalid("Unsupported OpenAI Responses tool choice");
  }
  return { type: "function", name: string(choice.name, "tool_choice name") };
}

function decodeExtensions(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const request = {
    ...(input.store === undefined ? {} : { store: input.store }),
    ...(input.previous_response_id === undefined
      ? {}
      : { previous_response_id: input.previous_response_id }),
    ...(input.prompt_cache_key === undefined ? {} : { prompt_cache_key: input.prompt_cache_key }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
  };
  if (input.store !== undefined && input.store !== null && typeof input.store !== "boolean") {
    return invalid("Invalid OpenAI Responses request: store must be a boolean");
  }
  if (
    input.previous_response_id !== undefined &&
    input.previous_response_id !== null &&
    typeof input.previous_response_id !== "string"
  ) {
    return invalid("Invalid OpenAI Responses request: previous_response_id must be a string");
  }
  if (
    input.prompt_cache_key !== undefined &&
    input.prompt_cache_key !== null &&
    typeof input.prompt_cache_key !== "string"
  ) {
    return invalid("Invalid OpenAI Responses request: prompt_cache_key must be a string");
  }
  if (
    input.reasoning !== undefined &&
    input.reasoning !== null &&
    (!isRecord(input.reasoning) || !isJsonValue(input.reasoning))
  ) {
    return invalid("Invalid OpenAI Responses request: reasoning must contain JSON values");
  }
  return Object.keys(request).length === 0 ? undefined : request;
}

export function decodeResponsesRequest(value: unknown): CanonicalRequest {
  const input = record(value, "body");
  for (const key of Object.keys(input)) {
    if (!supportedTopLevelFields.has(key)) {
      return invalid("Unsupported OpenAI Responses request field");
    }
  }
  if (input.background === true) {
    return invalid("Background Responses are not supported");
  }
  if (input.background !== undefined && input.background !== null && input.background !== false) {
    return invalid("Invalid OpenAI Responses request: background must be a boolean");
  }
  if (input.stream !== undefined && input.stream !== null && typeof input.stream !== "boolean") {
    return invalid("Invalid OpenAI Responses request: stream must be a boolean");
  }
  if (
    input.parallel_tool_calls !== undefined &&
    input.parallel_tool_calls !== null &&
    typeof input.parallel_tool_calls !== "boolean"
  ) {
    return invalid("Invalid OpenAI Responses request: parallel_tool_calls must be a boolean");
  }
  if (
    input.instructions !== undefined &&
    input.instructions !== null &&
    typeof input.instructions !== "string"
  ) {
    return invalid("Invalid OpenAI Responses request: instructions must be a string");
  }
  const maxOutputTokens = optionalNumber(input.max_output_tokens, "max_output_tokens");
  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0)
  ) {
    return invalid(
      "Invalid OpenAI Responses request: max_output_tokens must be a non-negative integer",
    );
  }
  const temperature = optionalNumber(input.temperature, "temperature");
  const topP = optionalNumber(input.top_p, "top_p");
  const metadata =
    input.metadata === undefined || input.metadata === null
      ? undefined
      : jsonRecord(input.metadata, "metadata");
  const toolChoice = decodeToolChoice(input.tool_choice);
  const extensions = decodeExtensions(input);

  return {
    source: "openai-responses",
    model: string(input.model, "model"),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    messages: [
      ...(typeof input.instructions === "string"
        ? [
            {
              role: "developer" as const,
              content: [{ type: "text" as const, text: input.instructions }],
            },
          ]
        : []),
      ...decodeInput(input.input),
    ],
    tools: decodeTools(input.tools),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(typeof input.parallel_tool_calls === "boolean"
      ? { parallelToolCalls: input.parallel_tool_calls }
      : {}),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    stream: input.stream === true,
    ...(metadata === undefined ? {} : { metadata }),
    ...(extensions === undefined
      ? {}
      : { extensions: { source: "openai-responses", request: extensions } }),
  };
}
