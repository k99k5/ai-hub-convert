import { describe, expect, it } from "vitest";
import {
  ToolArgumentLimitError,
  ToolArgumentStreamLimiter,
} from "../../src/stream/tool-argument-limits.js";

describe("ToolArgumentStreamLimiter", () => {
  it("allows the exact per-call and stream byte limits", () => {
    const limiter = new ToolArgumentStreamLimiter({ perCallBytes: 3, perStreamBytes: 3 });

    limiter.add(0, "你");
    limiter.finish(0);
  });

  it("rejects the next byte without exposing argument content", () => {
    const limiter = new ToolArgumentStreamLimiter({ perCallBytes: 3, perStreamBytes: 8 });
    limiter.add(0, "abc");

    expect(() => limiter.add(0, "secret-fragment")).toThrowError(ToolArgumentLimitError);
    try {
      limiter.add(1, "private-value");
    } catch (error) {
      expect(String(error)).not.toContain("private-value");
    }
  });

  it("applies a stream-wide limit across interleaved calls", () => {
    const limiter = new ToolArgumentStreamLimiter({ perCallBytes: 8, perStreamBytes: 5 });
    limiter.add(0, "abc");
    limiter.add(1, "de");

    expect(() => limiter.add(0, "f")).toThrowError(
      expect.objectContaining({ scope: "stream", code: "TOOL_ARGUMENTS_TOO_LARGE" }),
    );
  });

  it("counts a surrogate pair split across deltas as its final UTF-8 length", () => {
    const limiter = new ToolArgumentStreamLimiter({ perCallBytes: 4, perStreamBytes: 4 });

    limiter.add(0, "\ud83d");
    limiter.add(0, "\ude00");
    limiter.finish(0);
  });
});
