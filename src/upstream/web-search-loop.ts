import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../providers/web-search/internal.js";
import type { WebSearchRequest, WebSearchResult } from "../providers/web-search/types.js";

type CompletionPath = "responses" | "chat/completions";

export interface InternalWebSearchCall {
  id: string;
  arguments: string;
}

export interface InternalToolCalls {
  webSearch: InternalWebSearchCall[];
  hasOtherToolCalls: boolean;
}

export interface WebSearchExecution {
  id: string;
  query: string;
  results: WebSearchResult[];
}

const INTERNAL_WEB_SEARCH_TRACE_KEY = "__ai_hub_web_search_trace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWebSearchExecutions(value: unknown): WebSearchExecution[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const executions: WebSearchExecution[] = [];
  for (const rawExecution of value) {
    if (
      !isRecord(rawExecution) ||
      typeof rawExecution.id !== "string" ||
      typeof rawExecution.query !== "string" ||
      !Array.isArray(rawExecution.results)
    ) {
      return [];
    }
    const results: WebSearchResult[] = [];
    for (const rawResult of rawExecution.results) {
      if (
        !isRecord(rawResult) ||
        typeof rawResult.title !== "string" ||
        typeof rawResult.url !== "string" ||
        typeof rawResult.content !== "string"
      ) {
        return [];
      }
      results.push({
        title: rawResult.title,
        url: rawResult.url,
        content: rawResult.content,
      });
    }
    executions.push({ id: rawExecution.id, query: rawExecution.query, results });
  }
  return executions;
}

export function attachWebSearchExecutions(
  response: unknown,
  executions: readonly WebSearchExecution[],
): unknown {
  if (!isRecord(response) || executions.length === 0) {
    return response;
  }
  return {
    ...response,
    [INTERNAL_WEB_SEARCH_TRACE_KEY]: executions.map((execution) => ({
      id: execution.id,
      query: execution.query,
      results: execution.results.map((result) => ({ ...result })),
    })),
  };
}

export function getWebSearchExecutions(response: unknown): WebSearchExecution[] {
  return isRecord(response)
    ? normalizeWebSearchExecutions(response[INTERNAL_WEB_SEARCH_TRACE_KEY])
    : [];
}

export function getWebSearchRequestCount(response: unknown): number | undefined {
  if (
    !isRecord(response) ||
    !isRecord(response.usage) ||
    !isRecord(response.usage.server_tool_use)
  ) {
    return undefined;
  }
  const value = response.usage.server_tool_use.web_search_requests;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function attachWebSearchRequestCount(response: unknown, count: number): unknown {
  if (!isRecord(response) || !Number.isSafeInteger(count) || count <= 0) {
    return response;
  }
  const usage = isRecord(response.usage) ? response.usage : {};
  const serverToolUse = isRecord(usage.server_tool_use) ? usage.server_tool_use : {};
  const existing =
    typeof serverToolUse.web_search_requests === "number" &&
    Number.isSafeInteger(serverToolUse.web_search_requests) &&
    serverToolUse.web_search_requests >= 0
      ? serverToolUse.web_search_requests
      : 0;
  return {
    ...response,
    usage: {
      ...usage,
      server_tool_use: {
        ...serverToolUse,
        web_search_requests: existing + count,
      },
    },
  };
}

function isInternalWebSearchTool(path: CompletionPath, rawTool: unknown): boolean {
  if (!isRecord(rawTool)) {
    return false;
  }
  if (path === "responses") {
    return rawTool.type === "function" && rawTool.name === INTERNAL_WEB_SEARCH_TOOL_NAME;
  }
  const fn = rawTool.function;
  return rawTool.type === "function" && isRecord(fn) && fn.name === INTERNAL_WEB_SEARCH_TOOL_NAME;
}

export function hasInternalWebSearchTool(path: CompletionPath, body: unknown): boolean {
  return isRecord(body) && Array.isArray(body.tools)
    ? body.tools.some((rawTool) => isInternalWebSearchTool(path, rawTool))
    : false;
}

export function disableInternalWebSearchTool(
  path: CompletionPath,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((rawTool) => !isInternalWebSearchTool(path, rawTool))
    : undefined;
  const next: Record<string, unknown> = {
    ...body,
    ...(tools === undefined ? {} : { tools }),
  };
  const toolChoice = next.tool_choice;
  if (toolChoice === "required" && tools?.length === 0) next.tool_choice = "auto";
  if (path === "responses") {
    if (
      isRecord(toolChoice) &&
      toolChoice.type === "function" &&
      toolChoice.name === INTERNAL_WEB_SEARCH_TOOL_NAME
    ) {
      next.tool_choice = "auto";
    }
  } else if (
    isRecord(toolChoice) &&
    toolChoice.type === "function" &&
    isRecord(toolChoice.function) &&
    toolChoice.function.name === INTERNAL_WEB_SEARCH_TOOL_NAME
  ) {
    next.tool_choice = "auto";
  }
  return next;
}

export function releaseWebSearchToolChoice(
  path: CompletionPath,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const choice = body.tool_choice;
  const forcedSearch =
    isRecord(choice) &&
    choice.type === "function" &&
    (path === "responses"
      ? choice.name === INTERNAL_WEB_SEARCH_TOOL_NAME
      : isRecord(choice.function) && choice.function.name === INTERNAL_WEB_SEARCH_TOOL_NAME);
  return forcedSearch || choice === "required" ? { ...body, tool_choice: "auto" } : body;
}

export function forceNonStreamingBody(
  path: CompletionPath,
  body: unknown,
): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new Error("Web Search tool loop requires an object request body");
  }
  const next: Record<string, unknown> = { ...body, stream: false };
  if (path === "chat/completions") {
    delete next.stream_options;
  }
  return next;
}

export function extractInternalToolCalls(
  path: CompletionPath,
  response: unknown,
): InternalToolCalls {
  if (!isRecord(response)) {
    throw new Error("Web Search tool loop received an invalid upstream response");
  }
  return path === "responses"
    ? extractResponsesToolCalls(response)
    : extractChatToolCalls(response);
}

function extractResponsesToolCalls(response: Record<string, unknown>): InternalToolCalls {
  const output = Array.isArray(response.output) ? response.output : [];
  const webSearch: InternalWebSearchCall[] = [];
  let hasOtherToolCalls = false;
  for (const rawItem of output) {
    if (!isRecord(rawItem) || rawItem.type !== "function_call") {
      continue;
    }
    const name = rawItem.name;
    if (name !== INTERNAL_WEB_SEARCH_TOOL_NAME) {
      hasOtherToolCalls = true;
      continue;
    }
    if (typeof rawItem.call_id !== "string" || typeof rawItem.arguments !== "string") {
      throw new Error("Web Search function call is malformed");
    }
    webSearch.push({ id: rawItem.call_id, arguments: rawItem.arguments });
  }
  return { webSearch, hasOtherToolCalls };
}

function extractChatToolCalls(response: Record<string, unknown>): InternalToolCalls {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const message = first && isRecord(first.message) ? first.message : undefined;
  const toolCalls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const webSearch: InternalWebSearchCall[] = [];
  let hasOtherToolCalls = false;
  for (const rawCall of toolCalls) {
    if (!isRecord(rawCall)) {
      continue;
    }
    const fn = isRecord(rawCall.function) ? rawCall.function : undefined;
    if (!fn || fn.name !== INTERNAL_WEB_SEARCH_TOOL_NAME) {
      hasOtherToolCalls = true;
      continue;
    }
    if (typeof rawCall.id !== "string" || typeof fn.arguments !== "string") {
      throw new Error("Web Search function call is malformed");
    }
    webSearch.push({ id: rawCall.id, arguments: fn.arguments });
  }
  return { webSearch, hasOtherToolCalls };
}

export function decodeWebSearchRequest(argumentsJson: string): WebSearchRequest {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (isRecord(value) && typeof value.query === "string") {
      return { query: value.query };
    }
  } catch {
    // Invalid model-generated arguments are treated as an empty search for compatibility.
  }
  return { query: "" };
}

export function encodeWebSearchResults(results: readonly WebSearchResult[]): string {
  return JSON.stringify({
    ok: true,
    result_count: results.length,
    results: results.map((result) => ({
      title: result.title,
      url: result.url,
      content: result.content,
    })),
    ...(results.length === 0
      ? { message: "Web search completed successfully with 0 results. This is not an API error." }
      : {}),
  });
}

export function appendWebSearchResults(
  path: CompletionPath,
  requestBody: Record<string, unknown>,
  response: unknown,
  outputs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new Error("Web Search tool loop received an invalid upstream response");
  }
  return path === "responses"
    ? appendResponsesResults(requestBody, response, outputs)
    : appendChatResults(requestBody, response, outputs);
}

function appendResponsesResults(
  requestBody: Record<string, unknown>,
  response: Record<string, unknown>,
  outputs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const input = Array.isArray(requestBody.input) ? requestBody.input : [];
  const output = Array.isArray(response.output) ? response.output : [];
  const functionOutputs = [...outputs].map(([callId, result]) => ({
    type: "function_call_output",
    call_id: callId,
    output: result,
  }));
  return {
    ...requestBody,
    input: [...input, ...output, ...functionOutputs],
    stream: false,
  };
}

function appendChatResults(
  requestBody: Record<string, unknown>,
  response: Record<string, unknown>,
  outputs: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const assistant = first && isRecord(first.message) ? first.message : undefined;
  if (!assistant) {
    throw new Error("Web Search Chat response does not contain an assistant message");
  }
  const toolMessages = [...outputs].map(([callId, result]) => ({
    role: "tool",
    tool_call_id: callId,
    content: result,
  }));
  const next: Record<string, unknown> = {
    ...requestBody,
    messages: [...messages, assistant, ...toolMessages],
    stream: false,
  };
  delete next.stream_options;
  return next;
}
