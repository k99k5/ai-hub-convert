import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { parseSseStream } from "../../src/stream/sse-parser.js";
import { chatStream, responsesFrames } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
type Status = "completed" | "incomplete";
const apps: ReturnType<typeof buildApp>[] = [];
const modes = [
  { protocol: "chat", upstreamDone: true },
  { protocol: "responses", upstreamDone: true },
  { protocol: "responses", upstreamDone: false },
] as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(mode: (typeof modes)[number], status: Status) {
  const app = buildApp({
    config: loadConfig({
      UPSTREAM_BASE_URL: "https://upstream.test/v1",
      UPSTREAM_PROTOCOL: mode.protocol,
    }),
    logger: false,
    upstreamFetch: async () => {
      if (mode.protocol === "chat") {
        return chatStream({
          id: "chat_termination",
          model: "m",
          created: 123,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "正文正常" },
              finish_reason: status === "completed" ? "stop" : "length",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        });
      }
      const frames = responsesFrames({
        id: "resp_termination",
        model: "m",
        status,
        incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
        output: [
          {
            id: "msg_termination",
            type: "message",
            role: "assistant",
            status,
            content: [{ type: "output_text", text: "正文正常", annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      });
      return new Response((mode.upstreamDone ? frames : frames.slice(0, -1)).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  apps.push(app);
  return app;
}

describe.each(
  modes,
)("Responses SSE termination (upstream=$protocol, DONE=$upstreamDone)", (mode) => {
  it.each([
    "completed",
    "incomplete",
  ] as const)("ends with response.%s and every data event is JSON", async (status) => {
    const app = setup(mode, status);
    const result = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { authorization: "Bearer caller-key" },
      payload: { model: "m", input: "hello", stream: true },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.body).toContain('"delta":"正文正常"');

    const events: Wire[] = [];
    const body = new Response(result.body).body;
    if (!body) throw new Error("Expected an SSE body");
    // Consume through EOF like a JSON-only Responses client, without filtering sentinels.
    for await (const frame of parseSseStream(body)) {
      const event = JSON.parse(frame.data) as Wire;
      expect(event.type).toBe(frame.event);
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: `response.${status}`,
      response: {
        status,
        output: [{ content: [{ type: "output_text", text: "正文正常" }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    });
    expect(events.filter((event) => event.type === `response.${status}`)).toHaveLength(1);
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  });

  it("lets the OpenAI SDK aggregate a final response at EOF", async () => {
    const app = setup(mode, "completed");
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new OpenAI({ baseURL: `${address}/v1`, apiKey: "caller-key", maxRetries: 0 });
    const stream = client.responses.stream({ model: "m", input: "hello" });
    const response = await stream.finalResponse();
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe("正文正常");
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 2 });
  });
});
