import type {
  WebSearchCapabilities,
  WebSearchContext,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";

const DUCKDUCKGO_LITE_URL = "https://lite.duckduckgo.com/lite/";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DuckDuckGoWebSearchProvider implements WebSearchProvider {
  readonly #fetch: Fetch;

  constructor(fetch: Fetch = globalThis.fetch) {
    this.#fetch = fetch;
  }

  capabilities(): WebSearchCapabilities {
    return { execute: true, citations: false, streaming: false };
  }

  async execute(request: WebSearchRequest, context: WebSearchContext): Promise<WebSearchResult[]> {
    const query = request.query.trim();
    const maxResults = normalizeMaxResults(request.maxResults);
    if (!query || maxResults === 0) {
      return [];
    }

    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
    try {
      const url = new URL(DUCKDUCKGO_LITE_URL);
      url.searchParams.set("q", query);
      const response = await this.#fetch(url, {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": "Mozilla/5.0",
        },
        signal,
        redirect: "follow",
      });
      if (!response.ok) {
        return [];
      }

      const results = parseDuckDuckGoLite(await response.text());
      const filtered = request.domains?.length
        ? results.filter((result) => matchesDomain(result.url, request.domains ?? []))
        : results;
      return filtered.slice(0, maxResults);
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? error;
      }
      return [];
    }
  }
}

function normalizeMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(MAX_RESULTS, Math.max(0, Math.trunc(value)));
}

function parseDuckDuckGoLite(html: string): WebSearchResult[] {
  const links: Array<{ title: string; url: string }> = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = parseAttributes(match[1] ?? "");
    if (!hasClass(attributes, "result-link")) {
      continue;
    }
    const href = attributes.get("href");
    const title = stripHtml(match[2] ?? "");
    const url = href ? normalizeResultUrl(href) : undefined;
    if (title && url) {
      links.push({ title, url });
    }
  }

  const snippets: string[] = [];
  for (const match of html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const attributes = parseAttributes(match[1] ?? "");
    if (hasClass(attributes, "result-snippet")) {
      snippets.push(stripHtml(match[2] ?? ""));
    }
  }

  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  links.forEach((link, index) => {
    if (seen.has(link.url)) {
      return;
    }
    seen.add(link.url);
    results.push({
      title: link.title,
      url: link.url,
      content: snippets[index] ?? "",
    });
  });
  return results;
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return attributes;
}

function hasClass(attributes: ReadonlyMap<string, string>, className: string): boolean {
  return (attributes.get("class") ?? "").split(/\s+/).includes(className);
}

function normalizeResultUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtmlEntities(href).trim(), DUCKDUCKGO_LITE_URL);
    const host = url.hostname.toLowerCase();
    if (
      (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) &&
      url.pathname.replace(/\/+$/, "") === "/l"
    ) {
      const target = url.searchParams.get("uddg");
      if (target) {
        const destination = new URL(target);
        if (destination.protocol === "http:" || destination.protocol === "https:") {
          return destination.toString();
        }
      }
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-f]+|\d+)|amp|quot|apos|lt|gt|nbsp);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        nbsp: "\u00a0",
      };
      if (named[lower] !== undefined) {
        return named[lower];
      }
      if (!lower.startsWith("#")) {
        return match;
      }
      const hex = lower.startsWith("#x");
      const codePoint = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function matchesDomain(url: string, domains: readonly string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((rawDomain) => {
    const domain = rawDomain
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    return domain !== "" && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}
