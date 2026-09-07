import type { CanonicalRequest } from "../../core/ir.js";
import { DuckDuckGoWebSearchProvider } from "./duckduckgo.js";
import { WebSearchProviderRegistry } from "./registry.js";
import type { WebSearchProvider } from "./types.js";
import { WebSearchUnsupportedError } from "./unsupported.js";

export function createDefaultWebSearchRegistry(
  provider: WebSearchProvider = new DuckDuckGoWebSearchProvider(),
): WebSearchProviderRegistry {
  const registry = new WebSearchProviderRegistry();
  registry.register("web-search", provider);
  return registry;
}

export function assertWebSearchSupported(
  request: CanonicalRequest,
  registry: WebSearchProviderRegistry,
): void {
  for (const tool of request.tools) {
    if (tool.type !== "web_search") {
      continue;
    }
    if (!registry.get(tool.provider).capabilities().execute) {
      throw new WebSearchUnsupportedError();
    }
  }
}
