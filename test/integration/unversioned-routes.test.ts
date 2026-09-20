import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import { chatStream } from "../helpers/upstream.js";

type Wire = Record<string, unknown>;
const apps: ReturnType<typeof buildApp>[] = [];
const headers = { authorization: "Bearer caller-key" };
const routes = [
  { path: "/responses", payload: { model: "m", input: "hello" } },
  {
    path: "/chat/completions",
    payload: { model: "m", messages: [{ role: "user", content: "hello" }] },
  },
];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const calls: Array<{ url: string; authorization: string | null; body: Wire }> = [];
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async (url, init) => {
      const body = JSON.parse(init?.body as string) as Wire;
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });
      const response = {
        id: `chat_${calls.length}`,
        model: "m",
        created: 1,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "hello from upstream" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      };
      return body.stream ? chatStream(response) : Response.json(response);
    },
  });
  apps.push(app);
  return { app, calls };
}

describe.each(routes)("Unversioned $path alias", ({ path, payload }) => {
  it.each([false, true])("shares upstream behavior with /v1 (stream=%s)", async (stream) => {
    const { app, calls } = setup();
    for (const url of [`/v1${path}`, `${path}?client=test`]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers,
        payload: { ...payload, stream },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["content-type"]).toContain(
        stream ? "text/event-stream" : "application/json",
      );
      if (stream) {
        expect(response.body).toContain("hello from upstream");
        expect(response.body).toContain("data: [DONE]");
        if (path === "/responses") expect(response.body).toContain("event: response.completed");
      } else {
        expect(response.json()).toMatchObject(
          path === "/responses"
            ? { status: "completed", output: [{ content: [{ text: "hello from upstream" }] }] }
            : { choices: [{ message: { content: "hello from upstream" }, finish_reason: "stop" }] },
        );
      }
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://upstream.test/v1/chat/completions",
      authorization: "Bearer caller-key",
    });
    expect(calls[1]).toEqual(calls[0]);
  });

  it("keeps Bearer authentication and OpenAI request errors before calling upstream", async () => {
    const { app, calls } = setup();
    for (const url of [`/v1${path}`, `${path}?client=test`]) {
      const unauthorized = await app.inject({ method: "POST", url, payload });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json().error.type).toBe("authentication_error");
      for (const invalid of [{ ...payload, model: 42 }, '{"model":']) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { ...headers, "content-type": "application/json" },
          payload: invalid,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatchObject({
          type: "invalid_request_error",
          code: "invalid_request",
        });
        expect(response.json()).not.toHaveProperty("type");
      }
    }
    expect(calls).toHaveLength(0);
  });
});

it("continues Responses history across versioned and unversioned paths in both directions", async () => {
  const { app, calls } = setup();
  let previous_response_id: string | undefined;
  for (const url of ["/v1/responses", "/responses", "/v1/responses"]) {
    const response = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { model: "m", input: `turn ${calls.length + 1}`, previous_response_id },
    });
    expect(response.statusCode, response.body).toBe(200);
    previous_response_id = response.json().id;
  }
  expect(calls).toHaveLength(3);
  expect(calls[2]?.body.messages).toHaveLength(5);
  for (const text of ["turn 1", "turn 2", "turn 3", "hello from upstream"]) {
    expect(JSON.stringify(calls[2]?.body.messages)).toContain(text);
  }
  expect(calls[2]?.body).not.toHaveProperty("previous_response_id");
});
