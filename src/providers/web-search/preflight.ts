import type { CanonicalRequest } from "../../core/ir.js";
import { EmptyWebSearchProvider } from "./empty.js";
import { WebSearchProviderRegistry } from "./registry.js";
import { WebSearchUnsupportedError } from "./unsupported.js";

export function createDefaultWebSearchRegistry(): WebSearchProviderRegistry {
  const registry = new WebSearchProviderRegistry();
  registry.register("web-search", new EmptyWebSearchProvider());
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
