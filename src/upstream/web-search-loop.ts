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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function synthesizeCompletionStream(path: CompletionPath, response: unknown): Response {
  if (!isRecord(response)) {
    throw new Error("Cannot synthesize an event stream from an invalid upstream response");
  }
  const body =
    path === "responses" ? synthesizeResponsesStream(response) : synthesizeChatStream(response);
  const webSearchRequests = getWebSearchRequestCount(response);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      ...(webSearchRequests === undefined
        ? {}
        : { "x-ai-hub-web-search-requests": String(webSearchRequests) }),
    },
  });
}

function sse(event: string | undefined, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function normalizeSynthesizedResponsesItem(item: unknown): unknown {
  if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
    return item;
  }
  return {
    ...item,
    content: item.content.map((rawPart) => {
      if (
        !isRecord(rawPart) ||
        rawPart.type !== "output_text" ||
        Array.isArray(rawPart.annotations)
      ) {
        return rawPart;
      }
      return { ...rawPart, annotations: [] };
    }),
  };
}

function synthesizeResponsesStream(response: Record<string, unknown>): string {
  if (typeof response.id !== "string" || typeof response.model !== "string") {
    throw new Error("Cannot synthesize a Responses stream without id and model");
  }
  const frames: string[] = [
    sse("response.created", {
      type: "response.created",
      response: { id: response.id, model: response.model },
    }),
  ];
  const output = Array.isArray(response.output) ? response.output : [];
  output.forEach((rawItem, outputIndex) => {
    const item = normalizeSynthesizedResponsesItem(rawItem);
    frames.push(
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    );
  });
  const terminalType =
    response.status === "incomplete" ? "response.incomplete" : "response.completed";
  frames.push(sse(terminalType, { type: terminalType, response }), sse(undefined, "[DONE]"));
  return frames.join("");
}

function synthesizeChatStream(response: Record<string, unknown>): string {
  if (typeof response.id !== "string" || typeof response.model !== "string") {
    throw new Error("Cannot synthesize a Chat stream without id and model");
  }
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const message = first && isRecord(first.message) ? first.message : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((rawCall, index) =>
        isRecord(rawCall) ? { ...rawCall, index } : rawCall,
      )
    : undefined;
  const delta = {
    role: "assistant",
    ...(typeof message.reasoning_content === "string"
      ? { reasoning_content: message.reasoning_content }
      : typeof message.reasoning === "string"
        ? { reasoning: message.reasoning }
        : {}),
    ...(typeof message.content === "string" ? { content: message.content } : {}),
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
  const chunk = {
    id: response.id,
    model: response.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason:
          first && (typeof first.finish_reason === "string" || first.finish_reason === null)
            ? first.finish_reason
            : "stop",
      },
    ],
    ...(isRecord(response.usage) ? { usage: response.usage } : {}),
  };
  return sse(undefined, chunk) + sse(undefined, "[DONE]");
}
