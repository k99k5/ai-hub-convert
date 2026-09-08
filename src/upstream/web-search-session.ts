import type { CanonicalEvent } from "../core/events.js";
import type { Usage, WebSearchTool } from "../core/ir.js";
import { matchesSearchDomain } from "../providers/web-search/domains.js";
import type { WebSearchProvider } from "../providers/web-search/types.js";
import { StreamOutputLimitError } from "../stream/output-limits.js";
import {
  readCompletionUsage,
  replaceCompletionUsage,
  sumUsage,
  type CompletionPath,
} from "./usage.js";
import {
  appendWebSearchResults,
  attachWebSearchExecutions,
  attachWebSearchRequestCount,
  decodeWebSearchRequest,
  disableInternalWebSearchTool,
  encodeWebSearchResults,
  extractInternalToolCalls,
  releaseWebSearchToolChoice,
  type WebSearchExecution,
} from "./web-search-loop.js";

export class WebSearchSession {
  readonly executions: WebSearchExecution[] = [];
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  #retainedBytes = 0;

  constructor(
    readonly path: CompletionPath,
    private readonly provider: WebSearchProvider,
    private readonly retainedLimitBytes: number,
    private readonly policy?: WebSearchTool,
  ) {}

  prepare(body: Record<string, unknown>): Record<string, unknown> {
    return this.policy?.maxUses === 0 ? disableInternalWebSearchTool(this.path, body) : body;
  }

  async *advance(
    body: Record<string, unknown>,
    response: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<CanonicalEvent, Record<string, unknown> | undefined> {
    this.usage = sumUsage(this.usage, readCompletionUsage(this.path, response));
    const calls = extractInternalToolCalls(this.path, response);
    if (calls.webSearch.length === 0) return undefined;
    if (calls.hasOtherToolCalls) {
      throw new Error(
        "Upstream mixed internal Web Search with client-executed tool calls in one turn",
      );
    }
    this.#reserve(JSON.stringify(response));
    const outputs = new Map<string, string>();
    let allResultsEmpty = true;
    for (const call of calls.webSearch) {
      signal.throwIfAborted();
      if (this.executions.length >= (this.policy?.maxUses ?? Number.POSITIVE_INFINITY)) {
        outputs.set(call.id, JSON.stringify({ ok: false, error: "max_uses_exceeded" }));
        continue;
      }
      const search = {
        ...decodeWebSearchRequest(call.arguments),
        ...(this.policy?.searchContextSize === undefined
          ? {}
          : { maxResults: { low: 3, medium: 5, high: 10 }[this.policy.searchContextSize] }),
        ...(this.policy?.userLocation === undefined
          ? {}
          : { userLocation: this.policy.userLocation }),
        ...(this.policy?.allowedDomains === undefined
          ? {}
          : { domains: this.policy.allowedDomains }),
        ...(this.policy?.blockedDomains === undefined
          ? {}
          : { blockedDomains: this.policy.blockedDomains }),
      };
      yield { type: "web_search_start", id: call.id, query: search.query };
      const results = (await this.provider.execute(search, { requestId: call.id, signal })).filter(
        (result) =>
          (!search.domains?.length || matchesSearchDomain(result.url, search.domains)) &&
          (!search.blockedDomains?.length ||
            !matchesSearchDomain(result.url, search.blockedDomains)),
      );
      signal.throwIfAborted();
      const execution = { id: call.id, query: search.query, results };
      const output = encodeWebSearchResults(results);
      this.#reserve(JSON.stringify(execution));
      this.#reserve(output);
      this.executions.push(execution);
      yield { type: "web_search_result", execution };
      allResultsEmpty &&= results.length === 0;
      outputs.set(call.id, output);
    }
    let next = releaseWebSearchToolChoice(
      this.path,
      appendWebSearchResults(this.path, body, response, outputs),
    );
    if (
      allResultsEmpty ||
      this.executions.length >= (this.policy?.maxUses ?? Number.POSITIVE_INFINITY)
    ) {
      next = disableInternalWebSearchTool(this.path, next);
    }
    return next;
  }

  finish(response: unknown): unknown {
    return attachWebSearchExecutions(
      attachWebSearchRequestCount(
        replaceCompletionUsage(this.path, response, this.usage),
        this.executions.length,
      ),
      this.executions,
    );
  }

  #reserve(value: string): void {
    this.#retainedBytes += Buffer.byteLength(value, "utf8");
    if (this.#retainedBytes > this.retainedLimitBytes) {
      throw new StreamOutputLimitError("stream", this.retainedLimitBytes);
    }
  }
}
