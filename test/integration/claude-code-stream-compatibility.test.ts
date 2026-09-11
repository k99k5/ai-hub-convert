import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

type Wire = Record<string, unknown>;
const apps: ReturnType<typeof buildApp>[] = [];
const userAgent = "claude-cli/2.1.220 (external, cli)";
const reply = "页面摘要";
const refusal = "无法提供该内容";
const citation = {
  type: "url_citation",
  url: "https://example.test/page",
  title: "页面资料",
  start_index: 0,
  end_index: reply.length,
};
const fetchResult = "HTTP 200：已读取页面内容";
const anthropicRequest: Anthropic.MessageCreateParamsNonStreaming = {
  model: "model-test",
  max_tokens: 100,
  tools: [
    {
      name: "WebFetch",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  ],
  messages: [
    { role: "user", content: "读取网页并总结" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_fetch",
          name: "WebFetch",
          input: { url: citation.url },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_fetch", content: fetchResult, is_error: false },
      ],
    },
  ],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function frame(type: string, fields: Wire = {}): Wire {
  return { type, ...fields };
}

function textPart(text = "", annotations: Wire[] = []): Wire {
  return { type: "output_text", text, annotations };
}

function part(kind: "added" | "done", value?: Wire, contentIndex = 0): Wire {
  return frame(`response.content_part.${kind}`, {
    output_index: 0,
    item_id: "msg_answer",
    content_index: contentIndex,
    ...(value === undefined ? {} : { part: value }),
  });
}

function delta(text = reply, contentIndex = 0): Wire {
  return frame("response.output_text.delta", {
    output_index: 0,
    item_id: "msg_answer",
    content_index: contentIndex,
    delta: text,
  });
}

function annotation(contentIndex = 0): Wire {
  return frame("response.output_text.annotation.added", {
    output_index: 0,
    item_id: "msg_answer",
    content_index: contentIndex,
    annotation_index: 0,
    annotation: citation,
  });
}

function messageFrames(
  middle: Wire[],
  content: Wire[] = [textPart(reply)],
  initialContent: Wire[] = [],
  doneFields: Wire = {},
): Wire[] {
  const item = { type: "message", id: "msg_answer", role: "assistant" };
  const completed = { ...item, status: "completed", content, ...doneFields };
  return [
    frame("response.created", { response: { id: "resp_answer", model: "model-test" } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...item, content: initialContent },
    }),
    ...middle,
    frame("response.output_item.done", { output_index: 0, item: completed }),
    frame("response.completed", {
      response: {
        id: "resp_answer",
        model: "model-test",
        status: "completed",
        output: [completed],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ];
}

function setup(frames: Wire[]) {
  const requests: Wire[] = [];
  const app = buildApp({
    config: loadConfig({ UPSTREAM_BASE_URL: "https://upstream.test/v1" }),
    logger: false,
    upstreamFetch: async (input, init) => {
      expect(String(input)).toBe("https://upstream.test/v1/responses");
      requests.push(JSON.parse(init?.body as string) as Wire);
      const body = frames
        .map(
          (event, sequence_number) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
        )
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  apps.push(app);
  return { app, requests };
}

function readEvents(body: string): Wire[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Wire);
}

const cases: {
  name: string;
  frames: Wire[];
  text?: string;
  citation?: Wire;
  reasoning?: string;
}[] = [
  {
    name: "标准文本基准",
    frames: messageFrames([part("added", textPart()), delta(), part("done", textPart(reply))]),
  },
  {
    name: "初始空块再次收到 added",
    frames: messageFrames([part("added", textPart()), delta()], [textPart(reply)], [textPart()]),
  },
  {
    name: "初始完整正文再次收到 added 和 done 快照",
    frames: messageFrames(
      [part("added", textPart(reply)), part("done", textPart(reply))],
      [textPart(reply)],
      [textPart(reply)],
    ),
  },
  {
    name: "added 预填正文和引用后再收到真实增量",
    frames: messageFrames(
      [part("added", textPart(reply, [citation])), delta(), annotation()],
      [textPart(reply, [citation])],
    ),
    citation,
  },
  {
    name: "added 省略正文",
    frames: messageFrames([part("added", { type: "output_text", annotations: [] }), delta()]),
  },
  { name: "added 省略整个 part", frames: messageFrames([part("added"), delta()]) },
  {
    name: "done 省略引用而最终项保留引用",
    frames: messageFrames(
      [
        part("added", textPart()),
        delta(),
        annotation(),
        part("done", { type: "output_text", text: reply }),
      ],
      [textPart(reply, [citation])],
    ),
    citation,
  },
  {
    name: "done 省略正文和引用而最终项完整",
    frames: messageFrames(
      [part("added", textPart()), delta(), annotation(), part("done", { type: "output_text" })],
      [textPart(reply, [citation])],
    ),
    citation,
  },
  {
    name: "done 的空正文快照不覆盖真实增量",
    frames: messageFrames([part("added", textPart()), delta(), part("done", textPart())]),
  },
  {
    name: "重复 added 和 done 快照",
    frames: messageFrames([
      part("added", textPart()),
      part("added", textPart()),
      delta(),
      part("done", textPart(reply)),
      part("done", textPart(reply)),
    ]),
  },
  {
    name: "引用晚于 part.done",
    frames: messageFrames(
      [part("added", textPart()), delta(), part("done", textPart(reply)), annotation()],
      [textPart(reply, [citation])],
    ),
    citation,
  },
  {
    name: "空块只有 done",
    frames: messageFrames([part("done", textPart())], [textPart()]),
    text: "",
  },
  {
    name: "空块没有增量导致 content_index 跳号",
    frames: messageFrames(
      [delta("前文"), delta(reply, 2), annotation(2)],
      [textPart("前文"), textPart(), textPart(reply, [citation])],
    ),
    text: `前文${reply}`,
    citation: { ...citation, start_index: 2, end_index: 2 + reply.length },
  },
  ...[false, true].map((prefilled) => ({
    name: `拒绝正文仅在 done 到达，初始空拒绝块=${prefilled}`,
    frames: messageFrames(
      [part("added", { type: "refusal", refusal: "" }), part("done", { type: "refusal", refusal })],
      [{ type: "refusal", refusal }],
      prefilled ? [{ type: "refusal", refusal: "" }] : [],
    ),
    text: refusal,
  })),
  {
    name: "初始空拒绝块仅在最终项补全",
    frames: messageFrames([], [{ type: "refusal", refusal }], [{ type: "refusal", refusal: "" }]),
    text: refusal,
  },
];

const reasoning = "已读取页面，准备归纳";
const reasoningItem = {
  type: "reasoning",
  id: "reasoning_answer",
  status: "completed",
  summary: [{ type: "summary_text", text: reasoning }],
};
const reasoningFrames = messageFrames([delta()]);
reasoningFrames.splice(
  1,
  0,
  frame("response.output_item.added", {
    output_index: 1,
    item: { type: "reasoning", id: "reasoning_answer", summary: [] },
  }),
  frame("response.content_part.added", {
    output_index: 1,
    item_id: "reasoning_answer",
    content_index: 0,
    part: { type: "reasoning_text", text: "" },
  }),
  frame("response.reasoning_summary_text.delta", {
    output_index: 1,
    item_id: "reasoning_answer",
    summary_index: 0,
    delta: reasoning,
  }),
  frame("response.content_part.done", {
    output_index: 1,
    item_id: "reasoning_answer",
    content_index: 0,
    part: { type: "reasoning_text", text: reasoning },
  }),
  frame("response.output_item.done", {
    output_index: 1,
    item: reasoningItem,
  }),
);
const reasoningResponse = reasoningFrames.at(-1)?.response as Wire;
reasoningResponse.output = [...(reasoningResponse.output as Wire[]), reasoningItem];
cases.push({ name: "推理项携带 reasoning_text 辅助 part 帧", frames: reasoningFrames, reasoning });

const endpoints = ["/v1/messages", "/v1/responses"] as const;

async function inject(app: ReturnType<typeof buildApp>, endpoint: (typeof endpoints)[number]) {
  return app.inject({
    method: "POST",
    url: endpoint,
    headers: { authorization: "Bearer test-key", "user-agent": userAgent },
    payload:
      endpoint === "/v1/messages"
        ? { ...anthropicRequest, stream: true }
        : { model: "model-test", input: "总结已读取的网页", stream: true },
  });
}

function expectHistory(requests: Wire[]) {
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toContainEqual({
    type: "function_call",
    call_id: "toolu_fetch",
    name: "WebFetch",
    arguments: JSON.stringify({ url: citation.url }),
  });
  expect(requests[0]?.input).toContainEqual({
    type: "function_call_output",
    call_id: "toolu_fetch",
    output: fetchResult,
  });
}

describe("Claude Code 获取网页后续答的上游流兼容性", () => {
  it.each(
    endpoints.flatMap((endpoint) => cases.map((testCase) => ({ endpoint, ...testCase }))),
  )("$endpoint：$name", async ({
    endpoint,
    frames,
    text = reply,
    citation: expectedCitation,
    reasoning: expectedReasoning,
  }) => {
    const { app, requests } = setup(frames);
    const response = await inject(app, endpoint);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("The upstream stream failed");
    const events = readEvents(response.body);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const isAnthropic = endpoint === "/v1/messages";
    const terminal = isAnthropic ? "message_stop" : "response.completed";
    expect(events.filter((event) => event.type === terminal)).toHaveLength(1);
    const deltas = isAnthropic
      ? events
          .filter((event) => event.type === "content_block_delta")
          .map((event) => event.delta as Wire)
      : events;
    const textDeltas = deltas.filter((event) =>
      isAnthropic ? event.type === "text_delta" : event.type === "response.output_text.delta",
    );
    expect(textDeltas.map((event) => (isAnthropic ? event.text : event.delta)).join("")).toBe(text);
    const citations = deltas.filter((event) =>
      isAnthropic
        ? event.type === "citations_delta"
        : event.type === "response.output_text.annotation.added",
    );
    expect(citations).toHaveLength(expectedCitation ? 1 : 0);
    if (expectedCitation) {
      expect(isAnthropic ? citations[0]?.citation : citations[0]?.annotation).toMatchObject(
        isAnthropic
          ? {
              type: "web_search_result_location",
              url: citation.url,
              title: citation.title,
              cited_text: reply,
            }
          : expectedCitation,
      );
    }
    if (expectedReasoning) {
      const reasoningDeltas = deltas.filter((event) =>
        isAnthropic
          ? event.type === "thinking_delta"
          : event.type === "response.reasoning_summary_text.delta",
      );
      expect(
        reasoningDeltas.map((event) => (isAnthropic ? event.thinking : event.delta)).join(""),
      ).toBe(expectedReasoning);
    }
    if (isAnthropic) expectHistory(requests);
    else {
      expect(requests).toHaveLength(1);
      const completed = events.find((event) => event.type === "response.completed")
        ?.response as Wire;
      const message = (completed.output as Wire[]).find((item) => item.type === "message");
      expect(
        (message?.content as Wire[]).map((content) => content.text ?? content.refusal).join(""),
      ).toBe(text);
      expect(
        (message?.content as Wire[]).flatMap((content) => (content.annotations as Wire[]) ?? []),
      ).toEqual(expectedCitation ? [expectedCitation] : []);
    }
  });

  it.each(
    endpoints.flatMap((endpoint) =>
      [
        { name: "正文", content: [textPart("冲突的正文", [citation])], doneFields: {} },
        {
          name: "引用",
          content: [textPart(reply, [{ ...citation, url: "https://example.test/changed" }])],
          doneFields: {},
        },
        { name: "身份", content: [textPart(reply, [citation])], doneFields: { id: "msg_changed" } },
      ].map((conflict) => ({ endpoint, ...conflict })),
    ),
  )("$endpoint：最终 item.done 的$name 冲突仍必须报错", async ({
    endpoint,
    content,
    doneFields,
  }) => {
    const { app } = setup(messageFrames([delta(), annotation()], content, [], doneFields));
    const response = await inject(app, endpoint);
    expect(response.statusCode).toBe(200);
    const events = readEvents(response.body);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(
      events.some((event) => event.type === "message_stop" || event.type === "response.completed"),
    ).toBe(false);
  });

  it("Anthropic SDK 聚合 WebFetch 成功后的预填快照续答，正文和引用各一次", async () => {
    const { app, requests } = setup(
      messageFrames(
        [
          part("added", textPart(reply, [citation])),
          delta(),
          annotation(),
          part("done", { type: "output_text" }),
        ],
        [textPart(reply, [citation])],
      ),
    );
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Anthropic({
      apiKey: "test-key",
      authToken: null,
      baseURL: address,
      maxRetries: 0,
      defaultHeaders: { "user-agent": userAgent },
    });
    const result = await client.messages.stream(anthropicRequest).finalMessage();
    expect(result.stop_reason).toBe("end_turn");
    expect(result.content).toEqual([
      {
        type: "text",
        text: reply,
        citations: [
          {
            type: "web_search_result_location",
            url: citation.url,
            title: citation.title,
            cited_text: reply,
            encrypted_index: "",
          },
        ],
      },
    ]);
    expectHistory(requests);
  });
});
