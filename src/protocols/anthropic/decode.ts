import type {
  CanonicalRequest,
  CanonicalTool,
  Content,
  ImageContent,
  JsonSchemaOutputFormat,
  Message,
  ReasoningEffort,
  SearchResultContent,
  ToolChoice,
} from "../../core/ir.js";
import {
  createPromptCacheInput,
  type PromptCacheExplicitMarker,
  type PromptCacheMarker,
  type PromptCacheSidecar,
} from "../../policies/cache/sidecar.js";
import type { PromptCacheNodeId } from "../../policies/cache/planner.js";
import type { AnthropicImageMediaType } from "./types.js";

export type AnthropicDecodeErrorCode = "invalid_request" | "unsupported_content";

export class AnthropicDecodeError extends Error {
  readonly code: AnthropicDecodeErrorCode;

  constructor(code: AnthropicDecodeErrorCode, message: string) {
    super(message);
    this.name = "AnthropicDecodeError";
    this.code = code;
  }
}

const invalidRequest = (): never => {
  throw new AnthropicDecodeError("invalid_request", "Invalid Anthropic request");
};

const unsupportedContent = (): never => {
  throw new AnthropicDecodeError("unsupported_content", "Unsupported Anthropic content block");
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return invalidRequest();
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalidRequest();
  }
  return value;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    return invalidRequest();
  }
  return [...value];
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
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
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

function parseImage(block: Record<string, unknown>): ImageContent {
  const source = block.source;
  if (!isRecord(source)) {
    return invalidRequest();
  }
  if (source.type === "url") {
    return { type: "image", source: { type: "url", url: requiredString(source, "url") } };
  }
  if (source.type === "base64") {
    const mediaType = source.media_type;
    if (!isImageMediaType(mediaType) || typeof source.data !== "string") {
      return invalidRequest();
    }
    return {
      type: "image",
      source: { type: "base64", mediaType, data: source.data },
    };
  }
  return invalidRequest();
}

function isImageMediaType(value: unknown): value is AnthropicImageMediaType {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

function parseSearchResult(block: Record<string, unknown>): SearchResultContent {
  const content = block.content;
  if (!Array.isArray(content)) {
    return invalidRequest();
  }
  const text = content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        return invalidRequest();
      }
      return item.text;
    })
    .join("");
  const citations = block.citations;
  if (citations !== undefined && !isRecord(citations)) {
    return invalidRequest();
  }
  const enabled = citations?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return invalidRequest();
  }
  return {
    type: "search_result",
    title: requiredString(block, "title"),
    source: requiredString(block, "source"),
    content: text,
    citationsEnabled: enabled ?? false,
  };
}

function parseRegularBlock(block: unknown, role: "user" | "assistant"): Content {
  if (!isRecord(block) || typeof block.type !== "string") {
    return invalidRequest();
  }
  switch (block.type) {
    case "text":
      if (typeof block.text !== "string") {
        return invalidRequest();
      }
      return { type: "text", text: block.text };
    case "image":
      if (role !== "user") {
        return invalidRequest();
      }
      return parseImage(block);
    case "tool_use": {
      if (role !== "assistant" || !isJsonValue(block.input)) {
        return invalidRequest();
      }
      const serialized = JSON.stringify(block.input);
      if (serialized === undefined) {
        return invalidRequest();
      }
      return {
        type: "function_call",
        id: requiredString(block, "id"),
        name: requiredString(block, "name"),
        arguments: serialized,
      };
    }
    case "thinking": {
      if (role !== "assistant" || typeof block.thinking !== "string") {
        return invalidRequest();
      }
      if (block.signature !== undefined && typeof block.signature !== "string") {
        return invalidRequest();
      }
      return {
        type: "reasoning",
        text: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
        source: "anthropic",
      };
    }
    case "search_result":
      return parseSearchResult(block);
    case "tool_result":
      return invalidRequest();
    default:
      return unsupportedContent();
  }
}

function parseToolResult(block: Record<string, unknown>): Message {
  const callId = requiredString(block, "tool_use_id");
  if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
    return invalidRequest();
  }

  let output = "";
  const additionalContent: Content[] = [];
  if (typeof block.content === "string") {
    output = block.content;
  } else if (block.content !== undefined) {
    if (!Array.isArray(block.content)) {
      return invalidRequest();
    }
    const text: string[] = [];
    for (const item of block.content) {
      if (!isRecord(item) || typeof item.type !== "string") {
        return invalidRequest();
      }
      if (item.type === "text") {
        if (typeof item.text !== "string") {
          return invalidRequest();
        }
        text.push(item.text);
      } else if (item.type === "image") {
        additionalContent.push(parseImage(item));
      } else if (item.type === "search_result") {
        additionalContent.push(parseSearchResult(item));
      } else {
        return unsupportedContent();
      }
    }
    output = text.join("");
  }

  return {
    role: "tool",
    content: [
      {
        type: "function_result",
        callId,
        output,
        isError: block.is_error ?? false,
      },
      ...additionalContent,
    ],
  };
}

function parseMidConversationSystemMessage(record: Record<string, unknown>): Message {
  if (typeof record.content === "string") {
    return { role: "system", content: [{ type: "text", text: record.content }] };
  }
  if (!Array.isArray(record.content)) {
    return invalidRequest();
  }
  return {
    role: "system",
    content: record.content.map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
        return invalidRequest();
      }
      return { type: "text", text: block.text };
    }),
  };
}

function parseMessage(record: Record<string, unknown>): Message[] {
  const role = record.role;
  if (role === "system") {
    return [parseMidConversationSystemMessage(record)];
  }
  if (role !== "user" && role !== "assistant") {
    return invalidRequest();
  }
  if (typeof record.content === "string") {
    return [{ role, content: [{ type: "text", text: record.content }] }];
  }
  if (!Array.isArray(record.content)) {
    return invalidRequest();
  }

  const messages: Message[] = [];
  let current: Content[] = [];
  const flushCurrent = (): void => {
    if (current.length > 0) {
      messages.push({ role, content: current });
      current = [];
    }
  };

  for (const block of record.content) {
    if (
      isRecord(block) &&
      (block.type === "server_tool_use" || block.type === "web_search_tool_result")
    ) {
      if (role !== "assistant") {
        return invalidRequest();
      }
      if (block.type === "server_tool_use") {
        const input = block.input;
        if (
          block.name !== "web_search" ||
          typeof block.id !== "string" ||
          block.id.length === 0 ||
          !isRecord(input) ||
          typeof input.query !== "string"
        ) {
          return invalidRequest();
        }
      } else {
        if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
          return invalidRequest();
        }
        const content = block.content;
        if (
          !Array.isArray(content) &&
          !(
            isRecord(content) &&
            content.type === "web_search_tool_result_error" &&
            typeof content.error_code === "string"
          )
        ) {
          return invalidRequest();
        }
        if (
          Array.isArray(content) &&
          !content.every(
            (item) =>
              isRecord(item) &&
              item.type === "web_search_result" &&
              typeof item.url === "string" &&
              typeof item.title === "string",
          )
        ) {
          return invalidRequest();
        }
      }
      continue;
    }
    if (isRecord(block) && block.type === "tool_result") {
      if (role !== "user") {
        return invalidRequest();
      }
      flushCurrent();
      messages.push(parseToolResult(block));
    } else {
      current.push(parseRegularBlock(block, role));
    }
  }
  flushCurrent();
  if (messages.length === 0) {
    messages.push({ role, content: [] });
  }
  return messages;
}

function parseSystem(value: unknown): Message | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return { role: "system", content: [{ type: "text", text: value }] };
  }
  if (!Array.isArray(value)) {
    return invalidRequest();
  }
  return {
    role: "system",
    content: value.map((block) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
        return invalidRequest();
      }
      return { type: "text", text: block.text };
    }),
  };
}

function parsePromptCacheMarker(value: unknown): PromptCacheMarker | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const marker = isRecord(value) ? value : invalidRequest();
  if (Object.keys(marker).some((key) => key !== "type" && key !== "ttl")) {
    return invalidRequest();
  }
  if (marker.type !== "ephemeral") {
    return invalidRequest();
  }
  if (marker.ttl !== undefined && marker.ttl !== "5m" && marker.ttl !== "1h") {
    return invalidRequest();
  }
  return {
    type: "ephemeral",
    ...(marker.ttl === undefined ? {} : { ttl: marker.ttl }),
  };
}

function validateWebSearchDomains(tool: Record<string, unknown>): void {
  for (const key of ["allowed_domains", "blocked_domains"]) {
    const value = tool[key];
    if (
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || !value.every((domain) => typeof domain === "string"))
    ) {
      invalidRequest();
    }
  }
  if (tool.allowed_domains != null && tool.blocked_domains != null) {
    invalidRequest();
  }
}

function validateWebSearchLocation(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  const location = isRecord(value) ? value : invalidRequest();
  if (location.type !== "approximate") {
    invalidRequest();
  }
  for (const key of ["city", "country", "region", "timezone"]) {
    const field = location[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      invalidRequest();
    }
  }
}

function validateWebSearchTool(tool: Record<string, unknown>): void {
  if (tool.name !== "web_search") {
    invalidRequest();
  }
  if (
    tool.max_uses !== undefined &&
    tool.max_uses !== null &&
    (typeof tool.max_uses !== "number" || !Number.isSafeInteger(tool.max_uses) || tool.max_uses < 0)
  ) {
    invalidRequest();
  }
  if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
    invalidRequest();
  }
  if (tool.defer_loading !== undefined && typeof tool.defer_loading !== "boolean") {
    invalidRequest();
  }
  if (tool.allowed_callers !== undefined) {
    const allowedCallers = new Set([
      "direct",
      "code_execution_20250825",
      "code_execution_20260120",
      "code_execution_20260521",
    ]);
    if (
      !Array.isArray(tool.allowed_callers) ||
      !tool.allowed_callers.every(
        (caller): caller is string => typeof caller === "string" && allowedCallers.has(caller),
      )
    ) {
      invalidRequest();
    }
  }
  if (tool.cache_control !== undefined && tool.cache_control !== null) {
    parsePromptCacheMarker(tool.cache_control);
  }
  validateWebSearchDomains(tool);
  validateWebSearchLocation(tool.user_location);
}

function validateWebSearchVersionOptions(tool: Record<string, unknown>): void {
  if (tool.type === "web_search_20260318") {
    if (
      tool.response_inclusion !== undefined &&
      tool.response_inclusion !== "full" &&
      tool.response_inclusion !== "excluded"
    ) {
      invalidRequest();
    }
    return;
  }
  if (tool.response_inclusion !== undefined) {
    invalidRequest();
  }
}

function parseTools(value: unknown): CanonicalTool[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return invalidRequest();
  }
  return value.map((tool) => {
    if (!isRecord(tool)) {
      return invalidRequest();
    }
    if (
      tool.type === "web_search_20250305" ||
      tool.type === "web_search_20260209" ||
      tool.type === "web_search_20260318"
    ) {
      validateWebSearchTool(tool);
      validateWebSearchVersionOptions(tool);
      return {
        type: "web_search" as const,
        provider: "web-search" as const,
        version: tool.type,
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
        ...(typeof tool.max_uses === "number" ? { maxUses: tool.max_uses } : {}),
        ...(Array.isArray(tool.allowed_domains)
          ? { allowedDomains: [...tool.allowed_domains] as string[] }
          : {}),
        ...(Array.isArray(tool.blocked_domains)
          ? { blockedDomains: [...tool.blocked_domains] as string[] }
          : {}),
      };
    }
    if (!isRecord(tool.input_schema) || !isJsonValue(tool.input_schema)) {
      return invalidRequest();
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      return invalidRequest();
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      return invalidRequest();
    }
    if (tool.type !== undefined && tool.type !== "custom") {
      return invalidRequest();
    }
    return {
      type: "function",
      name: requiredString(tool, "name"),
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: tool.input_schema,
      strict: tool.strict ?? false,
    };
  });
}

function parseToolChoice(value: unknown): {
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
} {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return invalidRequest();
  }
  if (
    value.disable_parallel_tool_use !== undefined &&
    typeof value.disable_parallel_tool_use !== "boolean"
  ) {
    return invalidRequest();
  }
  const parallel =
    typeof value.disable_parallel_tool_use === "boolean"
      ? { parallelToolCalls: !value.disable_parallel_tool_use }
      : {};

  switch (value.type) {
    case "auto":
      return { toolChoice: { type: "auto" }, ...parallel };
    case "none":
      if (value.disable_parallel_tool_use !== undefined) {
        return invalidRequest();
      }
      return { toolChoice: { type: "none" } };
    case "any":
      return { toolChoice: { type: "required" }, ...parallel };
    case "tool":
      return {
        toolChoice: { type: "function", name: requiredString(value, "name") },
        ...parallel,
      };
    default:
      return invalidRequest();
  }
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isJsonValue(value)) {
    return invalidRequest();
  }
  return value;
}

function parseOutputConfig(value: unknown): {
  reasoningEffort?: ReasoningEffort;
  outputFormat?: JsonSchemaOutputFormat;
} {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return invalidRequest();
  }
  for (const key of Object.keys(value)) {
    if (key !== "effort" && key !== "format") {
      return invalidRequest();
    }
  }

  const effort = value.effort;
  if (
    effort !== undefined &&
    effort !== null &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    return invalidRequest();
  }

  let outputFormat: JsonSchemaOutputFormat | undefined;
  const format = value.format;
  if (format !== undefined && format !== null) {
    if (
      !isRecord(format) ||
      format.type !== "json_schema" ||
      !isRecord(format.schema) ||
      !isJsonValue(format.schema) ||
      Object.keys(format).some((key) => key !== "type" && key !== "schema")
    ) {
      return invalidRequest();
    }
    outputFormat = { type: "json_schema", schema: format.schema };
  }

  return {
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(outputFormat === undefined ? {} : { outputFormat }),
  };
}

function parseThinking(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !isJsonValue(value)) {
    return invalidRequest();
  }
  if (value.type === "disabled") {
    return value;
  }
  if (value.type === "adaptive") {
    if (
      value.display !== undefined &&
      value.display !== null &&
      value.display !== "summarized" &&
      value.display !== "omitted"
    ) {
      return invalidRequest();
    }
    return value;
  }
  if (
    value.type === "enabled" &&
    typeof value.budget_tokens === "number" &&
    Number.isInteger(value.budget_tokens) &&
    value.budget_tokens >= 0
  ) {
    if (
      value.display !== undefined &&
      value.display !== null &&
      value.display !== "summarized" &&
      value.display !== "omitted"
    ) {
      return invalidRequest();
    }
    return value;
  }
  return invalidRequest();
}

function isAnthropicToolSearchTool(tool: Record<string, unknown>): boolean {
  switch (tool.type) {
    case "tool_search_tool_regex":
    case "tool_search_tool_regex_20251119":
      if (tool.name !== "tool_search_tool_regex") {
        return invalidRequest();
      }
      return true;
    case "tool_search_tool_bm25":
    case "tool_search_tool_bm25_20251119":
      if (tool.name !== "tool_search_tool_bm25") {
        return invalidRequest();
      }
      return true;
    default:
      return false;
  }
}

// Anthropic executes Tool Search server-side. OpenAI-compatible upstreams cannot service it,
// so omit the search declaration. Claude Code can keep sending a previously unlocked deferred
// WebSearch tool without repeating the Tool Search declaration, so recognize that tool on its own.
function isDeferredClaudeCodeWebSearchTool(tool: Record<string, unknown>): boolean {
  return tool.name === "WebSearch" && tool.defer_loading === true;
}

function normalizeAnthropicToolSearchForConversion(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(input.tools)) {
    return input;
  }

  let changed = false;
  const tools = input.tools.flatMap((rawTool) => {
    if (!isRecord(rawTool)) {
      return [rawTool];
    }
    if (isAnthropicToolSearchTool(rawTool)) {
      changed = true;
      return [];
    }
    if (isDeferredClaudeCodeWebSearchTool(rawTool)) {
      if (!isRecord(rawTool.input_schema) || !isJsonValue(rawTool.input_schema)) {
        return invalidRequest();
      }
      if (rawTool.type !== undefined && rawTool.type !== "custom") {
        return invalidRequest();
      }
      if (rawTool.description !== undefined && typeof rawTool.description !== "string") {
        return invalidRequest();
      }
      if (rawTool.strict !== undefined && typeof rawTool.strict !== "boolean") {
        return invalidRequest();
      }
      changed = true;
      return [
        {
          type: "web_search_20250305",
          name: "web_search",
          defer_loading: true,
          ...(rawTool.cache_control === undefined ? {} : { cache_control: rawTool.cache_control }),
        },
      ];
    }
    return [rawTool];
  });

  return changed ? { ...input, tools } : input;
}

export interface DecodedAnthropicRequest {
  readonly request: CanonicalRequest;
  readonly promptCache: PromptCacheSidecar;
}

export function decodeAnthropicRequestWithSidecar(input: unknown): DecodedAnthropicRequest {
  if (!isRecord(input)) {
    return invalidRequest();
  }
  const normalizedInput = normalizeAnthropicToolSearchForConversion(input);
  const maxTokens = normalizedInput.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 0) {
    return invalidRequest();
  }
  const request = decodeRequest(normalizedInput, maxTokens);
  return { request, promptCache: decodePromptCacheSidecar(normalizedInput) };
}

export function decodeAnthropicRequest(input: unknown): CanonicalRequest {
  return decodeAnthropicRequestWithSidecar(input).request;
}

export function decodeAnthropicTokenCountRequest(input: unknown): CanonicalRequest {
  if (!isRecord(input)) {
    return invalidRequest();
  }
  const normalizedInput = normalizeAnthropicToolSearchForConversion(input);
  const request = decodeRequest(normalizedInput);
  decodePromptCacheSidecar(normalizedInput);
  return request;
}

function promptCacheMarkerForRegularBlock(
  block: Record<string, unknown>,
  terminal: boolean,
): PromptCacheMarker | undefined {
  if (
    block.type !== "text" &&
    block.type !== "image" &&
    block.type !== "tool_use" &&
    block.type !== "search_result"
  ) {
    if (block.cache_control !== undefined) {
      invalidRequest();
    }
    return undefined;
  }

  const marker = parsePromptCacheMarker(block.cache_control);
  if (marker && !terminal) {
    return invalidRequest();
  }
  return marker;
}

function promptCacheMarkerForToolResult(
  block: Record<string, unknown>,
): PromptCacheMarker | undefined {
  const outerMarker = parsePromptCacheMarker(block.cache_control);
  if (!Array.isArray(block.content)) {
    return outerMarker;
  }

  let nestedMarker: PromptCacheMarker | undefined;
  for (const [index, rawBlock] of block.content.entries()) {
    const contentBlock = isRecord(rawBlock) ? rawBlock : invalidRequest();
    if (
      contentBlock.type !== "text" &&
      contentBlock.type !== "image" &&
      contentBlock.type !== "search_result"
    ) {
      if (contentBlock.cache_control !== undefined) {
        invalidRequest();
      }
      continue;
    }

    const marker = parsePromptCacheMarker(contentBlock.cache_control);
    if (!marker) {
      continue;
    }
    if (index !== block.content.length - 1 || nestedMarker) {
      return invalidRequest();
    }
    nestedMarker = marker;
  }

  if (outerMarker && nestedMarker) {
    return invalidRequest();
  }
  return outerMarker ?? nestedMarker;
}

function decodePromptCacheSidecar(input: Record<string, unknown>): PromptCacheSidecar {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const system = input.system;
  const explicitMarkers: PromptCacheExplicitMarker[] = [];

  for (const [index, rawTool] of tools.entries()) {
    const tool = isRecord(rawTool) ? rawTool : invalidRequest();
    addPromptCacheMarker(explicitMarkers, `tool:${index}`, tool.cache_control);
  }

  let systemCount = 0;
  if (typeof system === "string") {
    systemCount = 1;
  } else if (Array.isArray(system)) {
    systemCount = system.length;
    for (const [index, rawBlock] of system.entries()) {
      const block = isRecord(rawBlock) ? rawBlock : invalidRequest();
      addPromptCacheMarker(explicitMarkers, `system:${index}`, block.cache_control);
    }
  }

  const rawMessages = Array.isArray(input.messages) ? input.messages : invalidRequest();
  let messageCount = 0;
  for (const rawMessage of rawMessages) {
    const message = isRecord(rawMessage) ? rawMessage : invalidRequest();
    if (typeof message.content === "string") {
      messageCount += 1;
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : invalidRequest();
    if (blocks.length === 0) {
      messageCount += 1;
      continue;
    }

    let hasRegularContent = false;
    for (const [blockIndex, rawBlock] of blocks.entries()) {
      const block = isRecord(rawBlock) ? rawBlock : invalidRequest();
      if (block.type === "tool_result") {
        if (hasRegularContent) {
          messageCount += 1;
          hasRegularContent = false;
        }
        const marker = promptCacheMarkerForToolResult(block);
        if (marker) {
          explicitMarkers.push({ nodeId: `message:${messageCount}`, marker });
        }
        messageCount += 1;
        continue;
      }

      hasRegularContent = true;
      const next = blocks[blockIndex + 1];
      const marker = promptCacheMarkerForRegularBlock(
        block,
        next === undefined || (isRecord(next) && next.type === "tool_result"),
      );
      if (marker) {
        explicitMarkers.push({ nodeId: `message:${messageCount}`, marker });
      }
    }
    if (hasRegularContent) {
      messageCount += 1;
    }
  }

  return {
    input: createPromptCacheInput(
      { toolCount: tools.length, systemCount, messageCount },
      explicitMarkers,
    ),
    explicitMarkers,
  };
}

function addPromptCacheMarker(
  markers: PromptCacheExplicitMarker[],
  nodeId: PromptCacheNodeId,
  value: unknown,
): void {
  const marker = parsePromptCacheMarker(value);
  if (marker) {
    markers.push({ nodeId, marker });
  }
}

function decodeRequest(input: Record<string, unknown>, maxTokens?: number): CanonicalRequest {
  const model = requiredString(input, "model");
  if (!Array.isArray(input.messages)) {
    return invalidRequest();
  }
  const firstMessage = input.messages[0];
  if (isRecord(firstMessage) && firstMessage.role === "system") {
    return invalidRequest();
  }
  if (input.stream !== undefined && typeof input.stream !== "boolean") {
    return invalidRequest();
  }

  const system = parseSystem(input.system);
  const messages = input.messages.flatMap((message) => {
    if (!isRecord(message)) {
      return invalidRequest();
    }
    return parseMessage(message);
  });
  const toolChoice = parseToolChoice(input.tool_choice);
  const temperature = optionalNumber(input, "temperature");
  const topP = optionalNumber(input, "top_p");
  const topK = optionalNumber(input, "top_k");
  const stopSequences = optionalStringArray(input, "stop_sequences");
  const metadata = parseMetadata(input.metadata);
  const outputConfig = parseOutputConfig(input.output_config);
  const thinking = parseThinking(input.thinking);
  if (
    input.prompt_cache_key !== undefined &&
    input.prompt_cache_key !== null &&
    typeof input.prompt_cache_key !== "string"
  ) {
    return invalidRequest();
  }
  const extensionRequest = {
    ...(input.prompt_cache_key === undefined ? {} : { prompt_cache_key: input.prompt_cache_key }),
    ...(topK !== undefined ? { top_k: topK } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };

  return {
    source: "anthropic",
    model,
    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
    ...(outputConfig.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: outputConfig.reasoningEffort }),
    ...(outputConfig.outputFormat === undefined ? {} : { outputFormat: outputConfig.outputFormat }),
    messages: [...(system ? [system] : []), ...messages],
    tools: parseTools(input.tools),
    ...toolChoice,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(stopSequences !== undefined ? { stopSequences } : {}),
    stream: input.stream ?? false,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(Object.keys(extensionRequest).length > 0
      ? { extensions: { source: "anthropic", request: extensionRequest } }
      : {}),
  };
}
