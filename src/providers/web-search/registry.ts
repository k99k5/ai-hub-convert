import type { WebSearchProvider } from "./types.js";

export class WebSearchProviderRegistry {
  readonly #providers = new Map<string, WebSearchProvider>();

  register(name: string, provider: WebSearchProvider): void {
    if (this.#providers.has(name)) {
      throw new Error(`Web Search provider is already registered: ${name}`);
    }
    this.#providers.set(name, provider);
  }

  get(name: string): WebSearchProvider {
    const provider = this.#providers.get(name);
    if (!provider) {
      throw new Error(`Web Search provider is not registered: ${name}`);
    }
    return provider;
  }
}
