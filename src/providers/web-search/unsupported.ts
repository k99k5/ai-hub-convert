import type {
  WebSearchCapabilities,
  WebSearchContext,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";

export class WebSearchUnsupportedError extends Error {
  constructor() {
    super("Web Search is not supported by the configured provider");
    this.name = "WebSearchUnsupportedError";
  }
}

export class UnsupportedWebSearchProvider implements WebSearchProvider {
  capabilities(): WebSearchCapabilities {
    return { execute: false, citations: false, streaming: false };
  }

  async execute(
    _request: WebSearchRequest,
    _context: WebSearchContext,
  ): Promise<WebSearchResult[]> {
    throw new WebSearchUnsupportedError();
  }
}
