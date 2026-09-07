import { describe, expect, it } from "vitest";
import { DuckDuckGoWebSearchProvider } from "../../src/providers/web-search/duckduckgo.js";

const RESULT_HTML = `
<table>
  <tr>
    <td>
      <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">
        Example &amp; <b>Docs</b>
      </a>
    </td>
  </tr>
  <tr><td class="result-snippet">Useful <b>docs</b> &amp; examples.</td></tr>
  <tr><td><a class="result-link" href="https://other.test/page">Other result</a></td></tr>
  <tr><td class="result-snippet">Other snippet.</td></tr>
</table>`;

describe("DuckDuckGo Web Search provider", () => {
  it("parses DuckDuckGo Lite results and unwraps redirect URLs", async () => {
    let requestedUrl: string | undefined;
    const provider = new DuckDuckGoWebSearchProvider(async (input) => {
      requestedUrl = String(input);
      return new Response(RESULT_HTML, { status: 200 });
    });

    const results = await provider.execute(
      { query: "node js", maxResults: 1 },
      { requestId: "req_test", signal: new AbortController().signal },
    );

    const url = new URL(requestedUrl ?? "https://invalid.test/");
    expect(url.origin + url.pathname).toBe("https://lite.duckduckgo.com/lite/");
    expect(url.searchParams.get("q")).toBe("node js");
    expect(results).toEqual([
      {
        title: "Example & Docs",
        url: "https://example.com/docs",
        content: "Useful docs & examples.",
      },
    ]);
  });

  it("filters results by requested domains", async () => {
    const provider = new DuckDuckGoWebSearchProvider(
      async () => new Response(RESULT_HTML, { status: 200 }),
    );

    await expect(
      provider.execute(
        { query: "docs", domains: ["example.com"] },
        { requestId: "req_test", signal: new AbortController().signal },
      ),
    ).resolves.toEqual([
      {
        title: "Example & Docs",
        url: "https://example.com/docs",
        content: "Useful docs & examples.",
      },
    ]);
  });

  it("returns no results when DuckDuckGo rejects the request", async () => {
    const provider = new DuckDuckGoWebSearchProvider(
      async () => new Response("rate limited", { status: 429 }),
    );

    await expect(
      provider.execute(
        { query: "docs" },
        { requestId: "req_test", signal: new AbortController().signal },
      ),
    ).resolves.toEqual([]);
  });

  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const provider = new DuckDuckGoWebSearchProvider(async (_input, init) => {
      if (init?.signal?.aborted) {
        throw init.signal.reason;
      }
      return new Response(RESULT_HTML, { status: 200 });
    });

    await expect(
      provider.execute({ query: "docs" }, { requestId: "req_test", signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });
});
