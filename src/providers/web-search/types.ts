export interface WebSearchCapabilities {
  execute: boolean;
  citations: boolean;
  streaming: boolean;
}

export interface WebSearchRequest {
  query: string;
  domains?: string[];
  maxResults?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchContext {
  requestId: string;
  signal: AbortSignal;
}

export interface WebSearchProvider {
  capabilities(): WebSearchCapabilities;
  execute(request: WebSearchRequest, context: WebSearchContext): Promise<WebSearchResult[]>;
}
