import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../src/core/events.js";
import { ResponsesStreamDecoder } from "../../src/protocols/openai-responses/stream-decode.js";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../src/providers/web-search/internal.js";

function frame(type: string, payload: Record<string, unknown>) {
  return { event: type, data: JSON.stringify({ type, ...payload }) };
}

function roundTrip(frames: ReturnType<typeof frame>[]) {
  const decoder = new ResponsesStreamDecoder(undefined, undefined, {
    allowIncompleteToolArguments: true,
  });
  const encoder = new ResponsesStreamEncoder();
  const events = frames.flatMap((input) => decoder.decode(input));
  decoder.finish();
  return { events, frames: events.flatMap((event) => encoder.encode(event)) };
}

const created = () => frame("response.created", { response: { id: "resp_1", model: "m" } });
const terminal = (incomplete = false) =>
  frame(incomplete ? "response.incomplete" : "response.completed", {
    response: {
      status: incomplete ? "incomplete" : "completed",
      incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
      usage: { input_tokens: 1, output_tokens: 2 },
    },
  });

function functionFrames(status: string, args: string, name = "f") {
  const item = { id: "fc_1", type: "function_call", call_id: "call_1", name };
  return [
    created(),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    frame("response.function_call_arguments.delta", {
      output_index: 0,
      item_id: "fc_1",
      delta: args,
    }),
    frame("response.output_item.done", {
      output_index: 0,
      item: { ...item, arguments: args, status },
    }),
    terminal(status === "incomplete"),
  ];
}

const citation = (url: string, end = 2) => ({
  type: "url_citation",
  url,
  start_index: 0,
  end_index: end,
});

function messageFrames(parts: Array<{ text: string; annotations: Record<string, unknown>[] }>) {
  const item = { id: "msg_1", type: "message", role: "assistant" };
  const frames = [
    created(),
    frame("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }),
  ];
  for (const [contentIndex, part] of parts.entries()) {
    const fields = { output_index: 0, item_id: "msg_1", content_index: contentIndex };
    frames.push(
      frame("response.content_part.added", {
        ...fields,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      frame("response.output_text.delta", { ...fields, delta: part.text }),
      ...part.annotations.map((annotation, annotationIndex) =>
        frame("response.output_text.annotation.added", {
          ...fields,
          annotation_index: annotationIndex,
          annotation,
        }),
      ),
      frame("response.content_part.done", { ...fields, part: { type: "output_text", ...part } }),
    );
  }
  frames.push(
    frame("response.output_item.done", {
      output_index: 0,
      item: { ...item, content: parts.map((part) => ({ type: "output_text", ...part })) },
    }),
    terminal(),
  );
  return frames;
}

describe("Responses 流式协议遗漏回归", () => {
  it("初始消息已有空文本块时辅助快照不重复创建内容块", () => {
    const inputs = messageFrames([{ text: "正常答案", annotations: [] }]);
    inputs[1] = frame("response.output_item.added", {
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      },
    });
    expect(roundTrip(inputs).events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", index: 0, delta: "正常答案" },
    ]);
  });

  it("初始空拒答占位块允许仅在最终输出项中提供完整拒答", () => {
    const item = { id: "msg_1", type: "message", role: "assistant" };
    const output = roundTrip([
      created(),
      frame("response.output_item.added", {
        output_index: 0,
        item: { ...item, content: [{ type: "refusal", refusal: "" }] },
      }),
      frame("response.output_item.done", {
        output_index: 0,
        item: { ...item, content: [{ type: "refusal", refusal: "无法回答" }] },
      }),
      terminal(),
    ]);
    expect(output.events).toContainEqual({ type: "text_delta", index: 0, delta: "无法回答" });
  });

  it("前置空内容块没有增量时后续文本块仍可正常输出", () => {
    const inputs = messageFrames([
      { text: "", annotations: [] },
      { text: "后续答案", annotations: [] },
    ]).filter((input) => {
      const payload = JSON.parse(input.data) as Record<string, unknown>;
      return !(input.event === "response.output_text.delta" && payload.content_index === 0);
    });
    expect(roundTrip(inputs).events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", index: 0, delta: "后续答案" },
    ]);
  });

  it("兼容仅通过输出序号定位的旧内容块事件", () => {
    const inputs = messageFrames([{ text: "内容", annotations: [] }]).map((input) => {
      if (!input.event.startsWith("response.content_part.")) return input;
      const payload = JSON.parse(input.data) as Record<string, unknown>;
      delete payload.item_id;
      return frame(input.event, payload);
    });
    expect(roundTrip(inputs).frames.at(-1)?.data).toMatchObject({
      response: { output: [{ content: [{ text: "内容" }] }] },
    });
  });

  it("截断工具参数以原始字符串和未完成状态往返", () => {
    const output = roundTrip(functionFrames("incomplete", '{"x":'));
    expect(output.events).toContainEqual({ type: "content_stop", index: 0, status: "incomplete" });
    expect(
      output.frames.find((item) => item.event === "response.output_item.done")?.data.item,
    ).toMatchObject({ status: "incomplete", arguments: '{"x":' });
    expect(output.frames.at(-1)?.data).toMatchObject({
      response: { status: "incomplete", output: [{ status: "incomplete", arguments: '{"x":' }] },
    });
  });

  it.each(["completed", "in_progress"])("%s 工具参数仍须为完整 JSON 对象", (status) => {
    for (const args of ['{"x":', "[]", "null"]) {
      expect(() => roundTrip(functionFrames(status, args))).toThrow(/JSON/);
    }
  });

  it("Anthropic 出口仍拒绝未完成的工具对象", () => {
    const decoder = new ResponsesStreamDecoder();
    expect(() =>
      functionFrames("incomplete", '{"x":').flatMap((input) => decoder.decode(input)),
    ).toThrow(/JSON/);
  });

  it("内部搜索即使标为未完成也不能接收截断参数", () => {
    expect(() =>
      roundTrip(functionFrames("incomplete", '{"query":', INTERNAL_WEB_SEARCH_TOOL_NAME)),
    ).toThrow(/JSON/);
  });

  it("未完成工具项也必须与已发送的原始参数一致", () => {
    const inputs = functionFrames("incomplete", '{"x":');
    const done = inputs[3];
    if (!done) throw new Error("测试完成事件缺失");
    const payload = JSON.parse(done.data) as { item: Record<string, unknown> };
    inputs[3] = frame("response.output_item.done", {
      output_index: 0,
      item: { ...payload.item, arguments: '{"y":' },
    });
    expect(() => roundTrip(inputs)).toThrow(/done body does not match/);
  });

  it.each(["message", "reasoning"])("%s 输出项保留未完成状态", (type) => {
    const item =
      type === "message"
        ? { id: "item_1", type, role: "assistant", content: [] }
        : { id: "item_1", type, summary: [] };
    const done =
      type === "message"
        ? { ...item, content: [{ type: "output_text", text: "片段", annotations: [] }] }
        : { ...item, summary: [{ type: "summary_text", text: "片段" }] };
    const output = roundTrip([
      created(),
      frame("response.output_item.added", { output_index: 0, item }),
      frame(
        type === "message" ? "response.output_text.delta" : "response.reasoning_summary_text.delta",
        {
          output_index: 0,
          content_index: 0,
          delta: "片段",
        },
      ),
      frame("response.output_item.done", {
        output_index: 0,
        item: { ...done, status: "incomplete" },
      }),
      terminal(true),
    ]);
    expect(output.frames.at(-1)?.data).toMatchObject({
      response: { output: [{ status: "incomplete" }] },
    });
  });

  it.each([0, 1, 2])("每块有 %s 条引用时按块重新计数并修正合并后偏移", (count) => {
    const annotations = Array.from({ length: count }, (_, index) =>
      citation(`https://x.test/${index}`),
    );
    const output = roundTrip(
      messageFrames([
        { text: "前言", annotations },
        { text: "后文", annotations },
        { text: "末尾", annotations: [] },
      ]),
    );
    const added = output.frames.filter(
      (item) => item.event === "response.output_text.annotation.added",
    );
    expect(added.map((item) => item.data.annotation_index)).toEqual(
      Array.from({ length: count * 2 }, (_, index) => index),
    );
    expect(added.map((item) => item.data.annotation)).toEqual([
      ...annotations,
      ...annotations.map((annotation) => ({ ...annotation, start_index: 2, end_index: 4 })),
    ]);
    expect(output.frames.at(-1)?.data).toMatchObject({
      response: { output: [{ content: [{ text: "前言后文末尾" }] }] },
    });
  });

  it("初始消息已含多个文本块时引用也使用合并后的偏移", () => {
    const item = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "前言", annotations: [] },
        { type: "output_text", text: "后文", annotations: [citation("https://x.test/s")] },
      ],
    };
    const output = roundTrip([
      created(),
      frame("response.output_item.added", { output_index: 0, item }),
      frame("response.output_item.done", { output_index: 0, item }),
      terminal(),
    ]);
    expect(output.events).toContainEqual({
      type: "citation_delta",
      index: 0,
      citation: { type: "url", url: "https://x.test/s", startIndex: 2, endIndex: 4 },
    } satisfies CanonicalEvent);
  });

  it("完成消息不能把同一段合并文本改成不同的块边界", () => {
    const inputs = messageFrames([
      { text: "前", annotations: [] },
      { text: "后文", annotations: [] },
    ]);
    inputs[inputs.length - 2] = frame("response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "前后", annotations: [] },
          { type: "output_text", text: "文", annotations: [] },
        ],
      },
    });
    expect(() => roundTrip(inputs)).toThrow();
  });

  it("后续文本块不能沿用前一块的引用序号", () => {
    const inputs = messageFrames([
      { text: "前言", annotations: [citation("https://x.test/first")] },
      { text: "后文", annotations: [citation("https://x.test/second")] },
    ]).map((input) => {
      const payload = JSON.parse(input.data) as Record<string, unknown>;
      return payload.type === "response.output_text.annotation.added" && payload.content_index === 1
        ? frame(input.event, { ...payload, annotation_index: 1 })
        : input;
    });
    expect(() => roundTrip(inputs)).toThrow(/annotations must be emitted in order/);
  });

  it("最终输出项的引用必须与已发送内容一致", () => {
    const inputs = messageFrames([
      { text: "内容", annotations: [citation("https://x.test/first")] },
    ]);
    const doneIndex = inputs.findIndex((input) => input.event === "response.output_item.done");
    inputs[doneIndex] = frame("response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "内容",
            annotations: [citation("https://x.test/changed")],
          },
        ],
      },
    });
    expect(() => roundTrip(inputs)).toThrow(/annotations do not match/);
  });

  it("前一块的延迟引用仍使用其原始偏移且不影响后一块序号", () => {
    const inputs = messageFrames([
      { text: "前言", annotations: [citation("https://x.test/first")] },
      { text: "后文", annotations: [citation("https://x.test/second")] },
    ]);
    const firstAnnotation = inputs.splice(4, 1)[0];
    const firstDone = inputs.splice(4, 1)[0];
    if (!firstAnnotation || !firstDone) throw new Error("测试引用事件缺失");
    inputs.splice(6, 0, firstAnnotation, firstDone);
    const output = roundTrip(inputs);
    expect(output.events.filter((event) => event.type === "citation_delta")).toMatchObject([
      { citation: { url: "https://x.test/first", startIndex: 0, endIndex: 2 } },
      { citation: { url: "https://x.test/second", startIndex: 2, endIndex: 4 } },
    ]);
  });

  it("已输出后续文本后拒绝回写前置文本造成引用偏移变化", () => {
    const decoder = new ResponsesStreamDecoder();
    decoder.decode(created());
    decoder.decode(
      frame("response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
    );
    for (const contentIndex of [0, 1]) {
      decoder.decode(
        frame("response.output_text.delta", {
          output_index: 0,
          content_index: contentIndex,
          delta: "文字",
        }),
      );
    }
    expect(() =>
      decoder.decode(
        frame("response.output_text.delta", {
          output_index: 0,
          content_index: 0,
          delta: "迟到",
        }),
      ),
    ).toThrow(/前置内容块/);
  });

  it("大量空内容块增量也受保留状态预算限制", () => {
    const decoder = new ResponsesStreamDecoder(undefined, {
      perItemBytes: 800,
      perStreamBytes: 800,
    });
    decoder.decode(created());
    decoder.decode(
      frame("response.output_item.added", {
        output_index: 0,
        item: { id: "msg_1", type: "message", role: "assistant", content: [] },
      }),
    );
    const part = (contentIndex: number) =>
      frame("response.output_text.delta", {
        output_index: 0,
        item_id: "msg_1",
        content_index: contentIndex,
        delta: "",
      });
    decoder.decode(part(0));
    decoder.decode(part(1));
    expect(() => decoder.decode(part(2))).toThrowError(
      expect.objectContaining({
        code: "STREAM_OUTPUT_TOO_LARGE",
        scope: "item",
      }),
    );
  });

  it("最终输出项不能遗漏实际出现的稀疏内容块", () => {
    const inputs = messageFrames([{ text: "", annotations: [] }]).map((input) =>
      input.event === "response.output_text.delta"
        ? frame(input.event, { ...JSON.parse(input.data), content_index: 2 })
        : input,
    );
    expect(() => roundTrip(inputs)).toThrow(/done body does not match/);
  });
});
