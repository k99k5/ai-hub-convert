import { describe, expect, it } from "vitest";
import { UpstreamClient, UpstreamHttpError } from "../../src/upstream/client.js";

function createFetch(response: Response) {
  return async () => response;
}

describe("UpstreamClient", () => {
  it("joins fixed upstream paths and forwards a request-scoped bearer token", async () => {
    let request: Request | undefined;
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/api/v1/"),
      timeoutMs: 10_000,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ id: "resp_1" });
      },
    });

    await client.postJson(
      "responses",
      { model: "model-a" },
      "secret",
      new AbortController().signal,
    );

    expect(request?.url).toBe("https://gateway.example.test/api/v1/responses");
    expect(request?.headers.get("authorization")).toBe("Bearer secret");
    expect(request?.headers.get("content-type")).toBe("application/json");
  });

  it("returns a sanitized error with the upstream request id", async () => {
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      fetch: createFetch(
        new Response(
          JSON.stringify({
            error: {
              code: "model_not_found",
              message: "internal https://private.example.test secret-token",
            },
          }),
          { status: 404, headers: { "x-request-id": "upstream-1" } },
        ),
      ),
    });

    let error: unknown;
    try {
      await client.postJson(
        "responses",
        { model: "missing" },
        "secret",
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect(error).toMatchObject({ status: 404, code: "model_not_found", requestId: "upstream-1" });
    expect(String(error)).not.toContain("private.example.test");
    expect(String(error)).not.toContain("secret-token");
  });

  it("rejects and cancels an oversized successful JSON body before parsing", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"private":"${"x".repeat(32)}"}`));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      jsonBodyLimitBytes: 16,
      errorBodyLimitBytes: 8,
      fetch: createFetch(response),
    });

    await expect(
      client.postJson("responses", {}, "secret", new AbortController().signal),
    ).rejects.toThrow("Upstream JSON body exceeds the configured byte limit");
    expect(cancelled).toBe(true);
  });

  it("bounds error envelopes without exposing or retaining their body", async () => {
    const privateBody = `{"error":{"code":"route_not_found","message":"${"secret".repeat(32)}"}}`;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(privateBody));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 404 },
    );
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      jsonBodyLimitBytes: 1024,
      errorBodyLimitBytes: 16,
      fetch: createFetch(response),
    });

    let error: unknown;
    try {
      await client.postJson("responses", {}, "secret", new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ status: 404, code: undefined });
    expect(String(error)).not.toContain(privateBody);
    expect(cancelled).toBe(true);
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      fetch: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return Response.json({});
      },
    });

    await expect(client.postJson("responses", {}, "secret", controller.signal)).rejects.toThrow(
      /client disconnected/,
    );
  });
});
