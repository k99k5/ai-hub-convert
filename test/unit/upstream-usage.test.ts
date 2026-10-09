import { describe, expect, it } from "vitest";
import { readCompletionUsage, replaceCompletionUsage } from "../../src/upstream/usage.js";

describe("上游用量读取", () => {
  it("把 null 用量明细和计数视为缺省", () => {
    const response = {
      usage: {
        prompt_tokens: 57,
        completion_tokens: 20,
        prompt_tokens_details: null,
        completion_tokens_details: { reasoning_tokens: null },
      },
    };
    expect(readCompletionUsage("chat/completions", response)).toEqual({
      inputTokens: 57,
      outputTokens: 20,
    });
    expect(
      replaceCompletionUsage("chat/completions", response, { inputTokens: 60, outputTokens: 25 }),
    ).toMatchObject({
      usage: { prompt_tokens: 60, completion_tokens: 25, total_tokens: 85 },
    });
  });

  it("非对象明细与非法计数仍然拒绝", () => {
    expect(() =>
      readCompletionUsage("responses", {
        usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: 1 },
      }),
    ).toThrow(/Invalid upstream usage object/);
    expect(() => readCompletionUsage("chat/completions", { usage: { prompt_tokens: -1 } })).toThrow(
      /Invalid upstream token usage/,
    );
  });
});
