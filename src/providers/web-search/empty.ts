import type {
  WebSearchCapabilities,
  WebSearchContext,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from "./types.js";

export class EmptyWebSearchProvider implements WebSearchProvider {
  capabilities(): WebSearchCapabilities {
    return { execute: true, citations: false, streaming: false };
  }

  async execute(
    _request: WebSearchRequest,
    _context: WebSearchContext,
  ): Promise<WebSearchResult[]> {
    return [];
  }
}
