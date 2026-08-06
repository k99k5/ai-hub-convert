import { describe, expect, it, vi } from "vitest";
import {
  parseSseStream,
  type SseEvent,
  SseStreamTimeoutError,
} from "../../src/stream/sse-parser.js";

function streamChunks(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const events = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("parseSseStream", () => {
  it("parses events split across arbitrary chunks and joins data lines", async () => {
    const events = await collect(
      streamChunks([
        'event: response.output_text.delta\r\ndata: {"delta":',
        '"hel',
        'lo"}\r\n',
        "data: second\r\n\r\n",
      ]),
    );

    expect(events).toEqual([
      { event: "response.output_text.delta", data: '{"delta":"hello"}\nsecond' },
    ]);
  });

  it("ignores comments and defaults event type to message", async () => {
    expect(await collect(streamChunks([": heartbeat\n\ndata: value\n\n"]))).toEqual([
      { event: "message", data: "value" },
    ]);
  });

  it("preserves a multibyte UTF-8 character split between byte chunks", async () => {
    const bytes = new TextEncoder().encode("data: 你\n\n");
    expect(await collect(streamChunks([bytes.slice(0, 7), bytes.slice(7)]))).toEqual([
      { event: "message", data: "你" },
    ]);
  });

  it("rejects malformed UTF-8 before it can corrupt frame accounting", async () => {
    const malformedFrames = Uint8Array.from(
      Array.from({ length: 8 }, () => [100, 97, 116, 97, 58, 32, 255, 10, 10]).flat(),
    );
    const oversizedTail = new TextEncoder().encode(`data: ${"x".repeat(40)}`);
    const stream = streamChunks([malformedFrames, oversizedTail]);
    const consume = async () => {
      for await (const _event of parseSseStream(stream, undefined, undefined, {
        maxFrameBytes: 16,
      })) {
        // No event is expected.
      }
    };

    await expect(consume()).rejects.toThrow("Upstream SSE stream is not valid UTF-8");
  });

  it("rejects an oversized frame split across chunks without exposing its content", async () => {
    const secret = "private-frame-content";
    const stream = streamChunks(["data: ", secret.slice(0, 8), secret.slice(8)]);
    const consume = async () => {
      for await (const _event of parseSseStream(stream, undefined, undefined, {
        maxFrameBytes: 12,
      })) {
        // No event is expected.
      }
    };

    try {
      await consume();
      throw new Error("Expected oversized SSE frame to fail");
    } catch (error) {
      expect(error).toMatchObject({ name: "SseFrameLimitError", limitBytes: 12 });
      expect(String(error)).not.toContain(secret);
    }
  });

  it("allows multiple frames whose combined chunk exceeds the per-frame limit", async () => {
    expect(
      await (async () => {
        const events = [];
        for await (const event of parseSseStream(
          streamChunks(["data: one\n\ndata: two\n\n"]),
          undefined,
          undefined,
          { maxFrameBytes: 11 },
        )) {
          events.push(event);
        }
        return events;
      })(),
    ).toEqual([
      { event: "message", data: "one" },
      { event: "message", data: "two" },
    ]);
  });

  it("cancels the upstream reader when the consumer stops before EOF", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: private-event-data\n\n"));
      },
      cancel,
    });

    for await (const _event of parseSseStream(stream)) {
      break;
    }

    expect(cancel).toHaveBeenCalledOnce();
    expect(String(cancel.mock.calls[0]?.[0])).toContain(
      "SSE stream consumption stopped before EOF",
    );
    expect(String(cancel.mock.calls[0]?.[0])).not.toContain("private-event-data");
  });

  it("does not cancel the upstream reader after normal EOF", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: complete\n\n"));
        controller.close();
      },
      cancel,
    });

    await collect(stream);

    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels a pending upstream read when the request signal aborts", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const consume = async () => {
      for await (const _event of parseSseStream(stream, undefined, controller.signal)) {
        // No event is expected.
      }
    };
    const consuming = consume();

    controller.abort(new Error("private-abort-reason"));
    await consuming;

    expect(cancel).toHaveBeenCalledOnce();
    expect(String(cancel.mock.calls[0]?.[0])).toContain("SSE stream aborted");
    expect(String(cancel.mock.calls[0]?.[0])).not.toContain("private-abort-reason");
  });

  it("times out before the first upstream byte", async () => {
    const onTimeout = vi.fn();
    const stream = new ReadableStream<Uint8Array>({});
    const consume = async () => {
      for await (const _event of parseSseStream(stream, {
        firstByteTimeoutMs: 5,
        idleTimeoutMs: 50,
        onTimeout,
      })) {
        // No event is expected.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "SseStreamTimeoutError",
      phase: "first-byte",
    });
    expect(onTimeout).toHaveBeenCalledWith(expect.any(SseStreamTimeoutError));
  });

  it("times out when the upstream becomes idle after an event", async () => {
    const bytes = new TextEncoder().encode("data: first\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
    });
    const events: SseEvent[] = [];
    const consume = async () => {
      for await (const event of parseSseStream(stream, {
        firstByteTimeoutMs: 50,
        idleTimeoutMs: 5,
      })) {
        events.push(event);
      }
    };

    await expect(consume()).rejects.toMatchObject({ phase: "idle" });
    expect(events).toEqual([{ event: "message", data: "first" }]);
  });
});
