import { EmptyWebSearchProvider } from "../providers/web-search/empty.js";
import { createDefaultWebSearchRegistry } from "../providers/web-search/preflight.js";
import type { WebSearchProvider } from "../providers/web-search/types.js";
import type { CanonicalEvent } from "../core/events.js";
import type { WebSearchTool } from "../core/ir.js";
import { streamCompletion, type CompletionStreamOptions } from "./completion-stream.js";
import { WebSearchSession } from "./web-search-session.js";
import { forceNonStreamingBody, hasInternalWebSearchTool } from "./web-search-loop.js";

type UpstreamPath = "responses" | "responses/input_tokens" | "chat/completions";
type CompletionPath = Exclude<UpstreamPath, "responses/input_tokens">;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface UpstreamClientOptions {
  baseUrl: URL;
  timeoutMs: number;
  jsonBodyLimitBytes?: number;
  errorBodyLimitBytes?: number;
  fetch?: Fetch;
  webSearchProvider?: WebSearchProvider;
}

const DEFAULT_JSON_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_ERROR_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_WEB_SEARCH_ROUNDS = 8;

interface UpstreamErrorEnvelope {
  error?: {
    code?: string | number;
  };
  code?: string | number;
}

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  hasUpstreamSemanticEvent = false;

  constructor(status: number, options: { code?: string; requestId?: string }) {
    super(`Upstream request failed with status ${status}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    if (options.code) {
      this.code = options.code;
    }
    if (options.requestId) {
      this.requestId = options.requestId;
    }
  }
}

export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamProtocolError";
  }
}

export class UpstreamClient {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #jsonBodyLimitBytes: number;
  readonly #errorBodyLimitBytes: number;
  readonly #fetch: Fetch;
  readonly #webSearchProviders: ReturnType<typeof createDefaultWebSearchRegistry>;

  constructor(options: UpstreamClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    this.#timeoutMs = options.timeoutMs;
    this.#jsonBodyLimitBytes = options.jsonBodyLimitBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
    this.#errorBodyLimitBytes = options.errorBodyLimitBytes ?? DEFAULT_ERROR_BODY_LIMIT_BYTES;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const webSearchProvider =
      options.webSearchProvider ??
      (options.fetch === undefined ? undefined : new EmptyWebSearchProvider());
    this.#webSearchProviders = createDefaultWebSearchRegistry(webSearchProvider);
  }

  async get(
    path: "usage" | "models",
    search: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
    signal.throwIfAborted();
    const url = new URL(path, this.#baseUrl);
    url.search = search;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal,
      redirect: "error",
    });
    const body = await readBodyBytes(
      response,
      response.ok ? this.#jsonBodyLimitBytes : this.#errorBodyLimitBytes,
    );
    return { status: response.status, headers: response.headers, body };
  }

  async postJson(
    path: UpstreamPath,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
    webSearch?: WebSearchTool,
  ): Promise<unknown> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
    signal.throwIfAborted();
    if (path !== "responses/input_tokens" && hasInternalWebSearchTool(path, body)) {
      return this.#postJsonWithWebSearchLoop(path, body, apiKey, signal, webSearch);
    }
    const response = await this.#post(path, body, apiKey, signal);
    return readJsonBody(response, this.#jsonBodyLimitBytes);
  }

  async postStream(
    path: CompletionPath,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]);
    signal.throwIfAborted();
    const response = await this.#post(path, body, apiKey, signal);
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!response.body || !contentType?.startsWith("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpstreamProtocolError("Upstream did not return an event stream");
    }
    return response;
  }

  async *streamCompletion(
    path: CompletionPath,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
    options: CompletionStreamOptions = {},
  ): AsyncGenerator<CanonicalEvent> {
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    let hasEvents = false;
    try {
      for await (const event of streamCompletion(
        path,
        body,
        (next, nextSignal) => this.postStream(path, next, apiKey, nextSignal),
        this.#webSearchProviders.get("web-search"),
        combinedSignal,
        options,
      )) {
        hasEvents = true;
        yield event;
      }
    } catch (error) {
      if (hasEvents && error instanceof UpstreamHttpError) error.hasUpstreamSemanticEvent = true;
      throw error;
    } finally {
      controller.abort();
    }
  }

  async #postJsonWithWebSearchLoop(
    path: CompletionPath,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
    webSearch?: WebSearchTool,
  ): Promise<unknown> {
    const session = new WebSearchSession(
      path,
      this.#webSearchProviders.get("web-search"),
      this.#jsonBodyLimitBytes,
      webSearch,
    );
    let currentBody = session.prepare(forceNonStreamingBody(path, body));
    for (let round = 0; round < MAX_WEB_SEARCH_ROUNDS; round += 1) {
      let response: Response;
      try {
        response = await this.#post(path, currentBody, apiKey, signal);
      } catch (error) {
        if (round > 0 && error instanceof UpstreamHttpError) error.hasUpstreamSemanticEvent = true;
        throw error;
      }
      const responseBody = await readJsonBody(response, this.#jsonBodyLimitBytes);
      const search = session.advance(currentBody, responseBody, signal);
      let step = await search.next();
      while (!step.done) step = await search.next();
      const next = step.value;
      if (!next) return session.finish(responseBody);
      currentBody = next;
    }
    throw new UpstreamProtocolError("Web Search tool loop exceeded the maximum number of rounds");
  }

  async #post(
    path: UpstreamPath,
    body: unknown,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Response> {
    signal.throwIfAborted();
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });

    if (!response.ok) {
      const envelope = await readErrorEnvelope(response, this.#errorBodyLimitBytes);
      const code = envelope?.error?.code ?? envelope?.code;
      const requestId = response.headers.get("x-request-id");
      throw new UpstreamHttpError(response.status, {
        ...(code !== undefined ? { code: String(code) } : {}),
        ...(requestId ? { requestId } : {}),
      });
    }

    return response;
  }
}

async function readErrorEnvelope(
  response: Response,
  limitBytes: number,
): Promise<UpstreamErrorEnvelope | undefined> {
  try {
    const value = await readJsonBody(response, limitBytes);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    return value as UpstreamErrorEnvelope;
  } catch {
    return undefined;
  }
}

async function readBodyBytes(response: Response, limitBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > limitBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new UpstreamProtocolError("Upstream JSON body exceeds the configured byte limit");
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let reachedEof = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        throw new UpstreamProtocolError("Upstream JSON body exceeds the configured byte limit");
      }
      chunks.push(value);
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBody(response: Response, limitBytes: number): Promise<unknown> {
  if (!response.body) {
    throw new UpstreamProtocolError("Upstream JSON response has no body");
  }
  const bytes = await readBodyBytes(response, limitBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UpstreamProtocolError("Upstream JSON body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamProtocolError("Upstream JSON body is malformed");
  }
}
