import { expect, it } from "vitest";
import { ResponsesStreamDecoder } from "../../src/protocols/openai-responses/stream-decode.js";

function frame(event: string, payload: Record<string, unknown>) {
  return { event, data: JSON.stringify(payload) };
}

it("accepts output_text without annotations in a real Responses stream", () => {
  const decoder = new ResponsesStreamDecoder();

  expect(
    decoder.decode(
      frame("response.created", {
        type: "response.created",
        response: { id: "resp_missing_annotations", model: "deepseek-v4-flash" },
      }),
    ),
  ).toEqual([
    {
      type: "response_start",
      id: "resp_missing_annotations",
      model: "deepseek-v4-flash",
    },
  ]);

  const item = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "2026年10月1日是星期四。" }],
  };

  expect(
    decoder.decode(
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 1,
        item,
      }),
    ),
  ).toEqual([
    {
      type: "content_start",
      index: 1,
      itemId: "msg_1",
      content: { type: "text", text: "" },
    },
    { type: "text_delta", index: 1, delta: "2026年10月1日是星期四。" },
  ]);

  expect(
    decoder.decode(
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 1,
        item,
      }),
    ),
  ).toEqual([{ type: "content_stop", index: 1, status: "completed" }]);

  expect(
    decoder.decode(
      frame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_missing_annotations",
          model: "deepseek-v4-flash",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ),
  ).toEqual([
    {
      type: "response_complete",
      finishReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ]);

  expect(() => decoder.finish()).not.toThrow();
});

it("still rejects a present non-array annotations field", () => {
  const decoder = new ResponsesStreamDecoder();
  decoder.decode(
    frame("response.created", {
      type: "response.created",
      response: { id: "resp_bad_annotations", model: "deepseek-v4-flash" },
    }),
  );

  expect(() =>
    decoder.decode(
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_bad",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x", annotations: null }],
        },
      }),
    ),
  ).toThrow("Responses output item 0 annotations do not match");
});
