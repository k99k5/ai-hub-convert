import type {
  CanonicalRequest,
  CanonicalTool,
  Content,
  Message,
  ToolChoice,
} from "../../core/ir.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../providers/web-search/internal.js";
import { OpenAIAdapterError, type ResponsesTextConfig } from "./types.js";
import { decodeWebSearchHistory } from "./web-search.js";

const errorCode = "INVALID_OPENAI_RESPONSES_REQUEST" as const;
const supportedTopLevelFields = new Set([
  "background",
  "input",
  "include",
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "temperature",
  "text",
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
      const detail = part.detail;
      if (
        detail !== undefined &&
        detail !== "auto" &&
        detail !== "low" &&
        detail !== "high" &&
        detail !== "original"
      ) {
        return invalid("图片 detail 必须是 auto、low、high 或 original");
      }
      return { ...decodeImage(part.image_url), ...(detail === undefined ? {} : { detail }) };
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
  let output = item.output;
  if (Array.isArray(output)) {
    output = output
      .map((rawPart) => {
        const part = record(rawPart, "function_call_output output item");
        if (part.type !== "input_text" || typeof part.text !== "string") {
          return invalid("function_call_output.output 仅支持字符串或 input_text 文本数组");
        }
        return part.text;
      })
      .join("");
  }
  if (typeof output !== "string") {
    return invalid("Unsupported OpenAI Responses input");
  }
  return {
    role: "tool",
    content: [
      {
        type: "function_result",
        callId: string(item.call_id, "function_call_output call_id"),
        output,
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
    if (item.type === "item_reference") {
      if (Object.keys(item).some((key) => key !== "type" && key !== "id")) {
        return invalid("item_reference 仅支持 type 和 id 字段");
      }
      return {
        role: "assistant",
        content: [],
        itemReference: { source: "openai-responses", id: string(item.id, "item_reference id") },
      };
    }
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
    if (item.type === "web_search_call") {
      return decodeWebSearchHistory(item);
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
  if (tool.external_web_access !== undefined && typeof tool.external_web_access !== "boolean") {
    invalid("external_web_access 必须是布尔值");
  }
  if (tool.external_web_access === false) {
    invalid("DuckDuckGo 搜索不支持 external_web_access=false 的离线缓存模式");
  }
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
    for (const key of Object.keys(tool.filters)) {
      if (key !== "allowed_domains" && key !== "blocked_domains") {
        invalid("不支持的网页搜索过滤条件");
      }
      const domains = tool.filters[key];
      if (
        domains !== undefined &&
        domains !== null &&
        (!Array.isArray(domains) ||
          domains.length > 100 ||
          !domains.every(
            (domain) =>
              typeof domain === "string" &&
              /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)*[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(
                domain,
              ),
          ))
      ) {
        invalid("网页搜索域名列表最多包含 100 个域名，不能包含协议、路径或空值");
      }
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
  if (Array.isArray(tool.search_content_types) && tool.search_content_types.includes("image")) {
    invalid("DuckDuckGo Lite 搜索只支持文本结果，不支持图片搜索");
  }
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
        ...(isRecord(tool.filters) && Array.isArray(tool.filters.blocked_domains)
          ? { blockedDomains: [...tool.filters.blocked_domains] as string[] }
          : {}),
        ...(tool.search_context_size === undefined
          ? {}
          : {
              searchContextSize: tool.search_context_size as "low" | "medium" | "high",
            }),
        ...(isRecord(tool.user_location)
          ? {
              userLocation: Object.fromEntries(
                Object.entries(tool.user_location).filter(
                  ([key, field]) =>
                    ["city", "country", "region", "timezone"].includes(key) &&
                    typeof field === "string",
                ),
              ),
            }
          : {}),
      };
    }
    if (tool.type !== "function") {
      return invalid("Unsupported OpenAI Responses tool");
    }
    if (tool.name === INTERNAL_WEB_SEARCH_TOOL_NAME) {
      invalid("函数名称与网关保留的搜索工具名称冲突");
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      return invalid("Invalid OpenAI Responses request: tool description must be a string");
    }
    if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== "boolean") {
      return invalid("Invalid OpenAI Responses request: tool strict must be a boolean");
    }
    return {
      type: "function" as const,
      name: string(tool.name, "tool name"),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: jsonRecord(tool.parameters, "tool parameters"),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    };
  });
}

function selectedTool(value: unknown, tools: CanonicalTool[]): CanonicalTool {
  const choice = record(value, "tool_choice");
  const tool = tools.find((candidate) =>
    choice.type === "function"
      ? candidate.type === "function" && candidate.name === choice.name
      : candidate.type === "web_search" &&
        (choice.type === candidate.version ||
          choice.type ===
            (candidate.version.startsWith("web_search_preview")
              ? "web_search_preview"
              : "web_search")),
  );
  if (!tool) invalid("tool_choice 必须选择已声明的工具");
  return tool;
}

function decodeToolChoice(value: unknown, tools: CanonicalTool[]): ToolChoice | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "auto" || value === "none" || value === "required") {
    return { type: value };
  }
  const choice = record(value, "tool_choice");
  if (choice.type === "allowed_tools") {
    if (
      (choice.mode !== "auto" && choice.mode !== "required") ||
      !Array.isArray(choice.tools) ||
      choice.tools.length === 0
    ) {
      invalid("allowed_tools 必须包含非空工具列表，mode 必须是 auto 或 required");
    }
    const allowed = new Set(choice.tools.map((tool) => selectedTool(tool, tools)));
    const selected = tools.filter((tool) => allowed.has(tool));
    tools.splice(0, tools.length, ...selected);
    return { type: choice.mode };
  }
  const tool = selectedTool(choice, tools);
  return {
    type: "function",
    name: tool.type === "web_search" ? INTERNAL_WEB_SEARCH_TOOL_NAME : tool.name,
  };
}

function decodeText(value: unknown): ResponsesTextConfig | undefined {
  if (value === undefined) return undefined;
  const text = record(value, "text");
  if (Object.keys(text).some((key) => key !== "format" && key !== "verbosity")) {
    return invalid("text 包含不支持的字段");
  }
  const verbosity = text.verbosity;
  if (
    verbosity !== undefined &&
    verbosity !== null &&
    verbosity !== "low" &&
    verbosity !== "medium" &&
    verbosity !== "high"
  ) {
    return invalid("text.verbosity 必须是 low、medium、high 或 null");
  }
  const result: ResponsesTextConfig = {
    ...(verbosity === undefined ? {} : { verbosity }),
  };
  if (text.format === undefined) return result;
  const format = record(text.format, "text.format");
  if (format.type === "text" || format.type === "json_object") {
    if (Object.keys(format).some((key) => key !== "type")) {
      return invalid("文本格式包含不支持的字段");
    }
    return { ...result, format: { type: format.type } };
  }
  if (
    format.type !== "json_schema" ||
    Object.keys(format).some(
      (key) => !["type", "name", "schema", "description", "strict"].includes(key),
    )
  ) {
    return invalid("不支持的 text.format");
  }
  const name = string(format.name, "text.format.name");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return invalid("文本格式名称不合法");
  if (format.description !== undefined && typeof format.description !== "string") {
    return invalid("文本格式 description 必须是字符串");
  }
  if (format.strict !== undefined && format.strict !== null && typeof format.strict !== "boolean") {
    return invalid("文本格式 strict 必须是布尔值或 null");
  }
  return {
    ...result,
    format: {
      type: "json_schema",
      name,
      schema: jsonRecord(format.schema, "text.format.schema"),
      ...(format.description === undefined ? {} : { description: format.description }),
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}

function decodeExtensions(input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    input.include !== undefined &&
    input.include !== null &&
    (!Array.isArray(input.include) ||
      !input.include.every(
        (value) =>
          value === "web_search_call.action.sources" || value === "reasoning.encrypted_content",
      ))
  ) {
    invalid("include 仅支持 web_search_call.action.sources 和 reasoning.encrypted_content");
  }
  const text = decodeText(input.text);
  const request = {
    ...(text === undefined ? {} : { text }),
    ...(input.include === undefined ? {} : { include: input.include }),
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
  const tools = decodeTools(input.tools);
  if (tools.filter((tool) => tool.type === "web_search").length > 1) {
    invalid("同一请求只能声明一个内置网页搜索工具");
  }
  const maxToolCalls = optionalNumber(input.max_tool_calls, "max_tool_calls");
  if (maxToolCalls !== undefined && (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1)) {
    invalid("max_tool_calls 必须是正整数");
  }
  for (const tool of tools) {
    if (tool.type === "web_search" && maxToolCalls !== undefined) tool.maxUses = maxToolCalls;
  }
  const toolChoice = decodeToolChoice(input.tool_choice, tools);
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
    tools,
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
