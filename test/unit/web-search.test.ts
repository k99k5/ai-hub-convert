import { describe, expect, it } from "vitest";
import type { CanonicalRequest } from "../../src/core/ir.js";
import {
  assertWebSearchSupported,
  createDefaultWebSearchRegistry,
} from "../../src/providers/web-search/preflight.js";
import { WebSearchProviderRegistry } from "../../src/providers/web-search/registry.js";
import type { WebSearchProvider } from "../../src/providers/web-search/types.js";
import {
  UnsupportedWebSearchProvider,
  WebSearchUnsupportedError,
} from "../../src/providers/web-search/unsupported.js";

function requestWithTools(tools: CanonicalRequest["tools"]): CanonicalRequest {
  return {
    source: "anthropic",
    model: "test-model",
    messages: [],
    tools,
    stream: false,
  };
}

function providerWithExecution(execute: boolean): WebSearchProvider {
  return {
    capabilities: () => ({ execute, citations: false, streaming: false }),
    execute: async () => [],
  };
}

describe("UnsupportedWebSearchProvider", () => {
  it("declares no execution capability and fails without a network hook", async () => {
    const provider = new UnsupportedWebSearchProvider();

    expect(provider.capabilities()).toEqual({ execute: false, citations: false, streaming: false });
    await expect(
      provider.execute(
        { query: "current weather" },
        { signal: new AbortController().signal, requestId: "req_test" },
      ),
    ).rejects.toBeInstanceOf(WebSearchUnsupportedError);
  });
});

describe("Web Search preflight", () => {
  it("registers the unsupported provider by default", () => {
    expect(() =>
      assertWebSearchSupported(
        requestWithTools([{ type: "web_search", provider: "web-search", version: "web_search" }]),
        createDefaultWebSearchRegistry(),
      ),
    ).toThrowError(WebSearchUnsupportedError);
  });

  it("ignores ordinary functions and accepts providers with execution capability", () => {
    const registry = new WebSearchProviderRegistry();
    registry.register("web-search", providerWithExecution(true));

    expect(() =>
      assertWebSearchSupported(
        requestWithTools([
          {
            type: "function",
            name: "web_search",
            inputSchema: { type: "object" },
            strict: false,
          },
          { type: "web_search", provider: "web-search", version: "web_search" },
        ]),
        registry,
      ),
    ).not.toThrow();
  });

  it("fails closed when a Web Search provider cannot execute", () => {
    const registry = new WebSearchProviderRegistry();
    registry.register("web-search", providerWithExecution(false));

    expect(() =>
      assertWebSearchSupported(
        requestWithTools([{ type: "web_search", provider: "web-search", version: "web_search" }]),
        registry,
      ),
    ).toThrowError(WebSearchUnsupportedError);
  });
});
