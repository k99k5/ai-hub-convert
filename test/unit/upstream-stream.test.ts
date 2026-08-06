import { describe, expect, it } from "vitest";
import { UpstreamClient, UpstreamProtocolError } from "../../src/upstream/client.js";

describe("UpstreamClient.postStream", () => {
  it("returns an event-stream response without buffering it", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        controller.close();
      },
    });
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      fetch: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } }),
    });

    const response = await client.postStream(
      "responses",
      { stream: true },
      "secret",
      new AbortController().signal,
    );

    expect(response.body).not.toBeNull();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("rejects a successful response with the wrong content type", async () => {
    const client = new UpstreamClient({
      baseUrl: new URL("https://gateway.example.test/v1/"),
      timeoutMs: 10_000,
      fetch: async () => Response.json({ unexpected: true }),
    });

    await expect(
      client.postStream("responses", {}, "secret", new AbortController().signal),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});
