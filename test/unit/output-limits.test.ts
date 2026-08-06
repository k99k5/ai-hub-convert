import { describe, expect, it } from "vitest";
import { StreamOutputLimitError, StreamOutputLimiter } from "../../src/stream/output-limits.js";

describe("StreamOutputLimiter", () => {
  it("counts split UTF-8 surrogate pairs exactly", () => {
    const limiter = new StreamOutputLimiter({ perItemBytes: 4, perStreamBytes: 4 });

    limiter.add(0, "\ud83d");
    expect(() => limiter.add(0, "\ude00")).not.toThrow();
    expect(() => limiter.add(0, "x")).toThrowError(
      expect.objectContaining({ code: "STREAM_OUTPUT_TOO_LARGE", scope: "item", limitBytes: 4 }),
    );
  });

  it("enforces item and aggregate budgets for unrelated fields", () => {
    const item = new StreamOutputLimiter({ perItemBytes: 2, perStreamBytes: 10 });
    item.addUnrelated(0, "ab");
    expect(() => item.addUnrelated(0, "c")).toThrowError(StreamOutputLimitError);

    const stream = new StreamOutputLimiter({ perItemBytes: 10, perStreamBytes: 2 });
    stream.addBytes(0, 1);
    stream.addBytes(1, 1);
    expect(() => stream.addBytes(2, 1)).toThrowError(
      expect.objectContaining({ scope: "stream", limitBytes: 2 }),
    );
  });

  it.each([
    { perItemBytes: 0, perStreamBytes: 1 },
    { perItemBytes: 1, perStreamBytes: 0 },
    { perItemBytes: 1.5, perStreamBytes: 2 },
  ])("rejects invalid limits: $perItemBytes/$perStreamBytes", (limits) => {
    expect(() => new StreamOutputLimiter(limits)).toThrow(/positive safe integer/);
  });
});
