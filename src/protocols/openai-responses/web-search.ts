import { createHash } from "node:crypto";
import type { ResponseFunctionWebSearch } from "openai/resources/responses/responses";
import type { CanonicalRequest, Citation, Message } from "../../core/ir.js";
import type { WebSearchExecution } from "../../upstream/web-search-loop.js";
import {
  DEFAULT_STREAM_OUTPUT_LIMITS,
  StreamOutputLimiter,
  type StreamOutputLimits,
} from "../../stream/output-limits.js";
import { OpenAIAdapterError } from "./types.js";

type Source = { url: string; title: string };

export function includeWebSearchSources(request: CanonicalRequest): boolean {
  const include = request.extensions?.request?.include;
  return Array.isArray(include) && include.includes("web_search_call.action.sources");
}

export function webSearchItemId(responseId: string, executionId: string, index: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([responseId, executionId, index]), "utf8")
    .digest("base64url");
  return `ws_ai_hub_${digest}`;
}

export function encodeWebSearchCall(
  id: string,
  query: string,
  status: ResponseFunctionWebSearch["status"],
  results?: readonly Source[],
): ResponseFunctionWebSearch {
  return {
    id,
    type: "web_search_call",
    status,
    action: {
      type: "search",
      query,
      queries: [query],
      ...(results === undefined
        ? {}
        : {
            sources: [...new Set(results.map((result) => result.url))].map((url) => ({
              type: "url" as const,
              url,
            })),
          }),
    },
  };
}

// 只为答案实际展示的检索链接生成引用，不把全部来源伪装成答案证据。
export function* webSearchCitations(
  text: string,
  sources: readonly Source[],
  existing: readonly Citation[] = [],
): Generator<Citation> {
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  const wholeUrls = new Set<string>();
  const positions = new Map<string, Set<string>>();
  for (const citation of existing) {
    const url = citation.url;
    if (citation.startIndex === undefined) wholeUrls.add(url);
    else {
      const ranges = positions.get(url) ?? new Set<string>();
      ranges.add(`${citation.startIndex}:${citation.endIndex}`);
      positions.set(url, ranges);
    }
  }
  const links = /(\[[^[\]\n]+\]\()?https?:\/\//g;
  const title = /[ \t]+"[^"\n]*"\)/y;
  for (let match = links.exec(text); match !== null; match = links.exec(text)) {
    const urlStart = match.index + (match[1]?.length ?? 0);
    let cursor = links.lastIndex;
    let depth = 0;
    let bracketDepth = 0;
    while (cursor < text.length) {
      const character = text[cursor] as string;
      if (/[\s<>"`]/.test(character)) break;
      if (character === "\\" && (text[cursor + 1] === "(" || text[cursor + 1] === ")")) {
        cursor += 2;
        continue;
      }
      if (character === "(") depth++;
      if (character === "[") bracketDepth++;
      if (character === "]") {
        if (bracketDepth === 0) break;
        bracketDepth--;
      }
      if (character === ")") {
        if (depth === 0) break;
        depth--;
      }
      cursor++;
    }
    let rawUrl = text.slice(urlStart, cursor);
    let startIndex = urlStart;
    let endIndex = cursor;
    let explicitLink = false;
    if (match[1]) {
      title.lastIndex = cursor;
      const suffix = text[cursor] === ")" ? ")" : title.exec(text)?.[0];
      if (suffix !== undefined) {
        explicitLink = true;
        startIndex = match.index;
        endIndex = cursor + suffix.length;
      }
    }
    // 显式目标中的标点属于 URL；裸链接也优先匹配完整的已知来源。
    if (!explicitLink && !byUrl.has(rawUrl.replace(/\\([()])/g, "$1"))) {
      rawUrl = rawUrl.replace(/[.,;:!?，。；：！？]+$/u, "");
      endIndex = urlStart + rawUrl.length;
    }
    const url = rawUrl.replace(/\\([()])/g, "$1");
    links.lastIndex = Math.max(cursor, endIndex);
    const source = byUrl.get(url);
    if (!source) continue;
    if (wholeUrls.has(url) || positions.get(url)?.has(`${startIndex}:${endIndex}`)) continue;
    yield { type: "url", url, title: source.title, startIndex, endIndex };
  }
}

export function addResponsesWebSearch(
  response: Record<string, unknown>,
  executions: readonly WebSearchExecution[],
  includeSources: boolean,
  limits: StreamOutputLimits = DEFAULT_STREAM_OUTPUT_LIMITS,
): Record<string, unknown> {
  if (executions.length === 0) return response;
  const limiter = new StreamOutputLimiter(limits);
  const searchItems = executions.map((execution, index) => {
    const item = encodeWebSearchCall(
      webSearchItemId(response.id as string, execution.id, index),
      execution.query,
      "completed",
      includeSources ? execution.results : undefined,
    );
    limiter.addUnrelated(index, JSON.stringify(item));
    return item;
  });
  const sources = executions.flatMap((execution) => execution.results);
  const output = response.output as Array<Record<string, unknown>>;
  const messages = output.map((item, index) => {
    const outputIndex = searchItems.length + index;
    limiter.addUnrelated(outputIndex, JSON.stringify(item));
    if (item.type !== "message") return item;
    return {
      ...item,
      content: (item.content as Array<Record<string, unknown>>).map((part) => {
        if (part.type !== "output_text") return part;
        const annotations = part.annotations as Array<Record<string, unknown>>;
        const existing = annotations.map((annotation) => ({
          type: "url" as const,
          url: annotation.url as string,
          ...(typeof annotation.start_index === "number"
            ? { startIndex: annotation.start_index }
            : {}),
          ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}),
        }));
        const combined = [...annotations];
        for (const citation of webSearchCitations(part.text as string, sources, existing)) {
          const annotation = {
            type: "url_citation",
            url: citation.url,
            title: citation.title,
            start_index: citation.startIndex,
            end_index: citation.endIndex,
          };
          // 每条扩张后的注解先计费，避免构造完整大数组后才触发限额。
          limiter.addUnrelated(outputIndex, JSON.stringify(annotation));
          limiter.addBytes(outputIndex, 1);
          combined.push(annotation);
        }
        return { ...part, annotations: combined };
      }),
    };
  });
  return { ...response, output: [...searchItems, ...messages] };
}

function invalidHistory(): never {
  throw new OpenAIAdapterError(
    "INVALID_OPENAI_RESPONSES_REQUEST",
    "无效的 web_search_call 历史记录",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function decodeWebSearchHistory(item: Record<string, unknown>): Message {
  if (
    typeof item.id !== "string" ||
    !item.id ||
    !["in_progress", "searching", "completed", "failed"].includes(item.status as string) ||
    !isRecord(item.action)
  )
    invalidHistory();
  const action = item.action;
  let history: Record<string, unknown>;
  if (action.type === "search") {
    if (
      (action.query !== undefined && typeof action.query !== "string") ||
      (action.queries !== undefined &&
        (!Array.isArray(action.queries) ||
          !action.queries.every((query) => typeof query === "string"))) ||
      (action.sources !== undefined &&
        (!Array.isArray(action.sources) ||
          !action.sources.every(
            (source) => isRecord(source) && source.type === "url" && isWebUrl(source.url),
          )))
    ) {
      invalidHistory();
    }
    history = {
      type: "search",
      queries: action.queries ?? (action.query === undefined ? [] : [action.query]),
      sources:
        action.sources === undefined
          ? []
          : (action.sources as Array<{ url: string }>).map((source) => source.url),
    };
  } else if (action.type === "open_page") {
    if (action.url !== undefined && action.url !== null && !isWebUrl(action.url)) invalidHistory();
    history = { type: "open_page", url: action.url ?? null };
  } else if (action.type === "find_in_page") {
    if (!isWebUrl(action.url) || typeof action.pattern !== "string") invalidHistory();
    history = { type: "find_in_page", url: action.url, pattern: action.pattern };
  } else {
    invalidHistory();
  }
  // 历史只提供上下文；不向上游发送其未执行过的原生搜索项，也不重新执行搜索。
  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `历史网页搜索记录：${JSON.stringify({ status: item.status, ...history })}`,
      },
    ],
  };
}
