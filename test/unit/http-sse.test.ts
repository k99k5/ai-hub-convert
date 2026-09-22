import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientSseSender, ClientStreamClosedError } from "../../src/http/sse.js";

function createConnection(options: ConstructorParameters<typeof ClientSseSender>[1] = {}) {
  let connected = true;
  let close: (() => void) | undefined;
  let send = async (_frame: unknown): Promise<void> => {
    raw.headersSent = true;
  };
  const raw = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writable: true,
    writableNeedDrain: false,
    flushHeaders: vi.fn(),
    write: vi.fn((_frame: string) => true),
    destroy: vi.fn(() => {
      connected = false;
      raw.destroyed = true;
      raw.writable = false;
      close?.();
    }),
  };
  const header = vi.fn();
  const sender = new ClientSseSender(
    {
      raw,
      header,
      sse: {
        get isConnected() {
          return connected;
        },
        onClose(callback) {
          close = callback;
        },
        send: (frame) => send(frame),
        sendHeaders: () => {
          raw.headersSent = true;
        },
      },
    },
    options,
  );

  return {
    raw,
    header,
    sender,
    setSend: (replacement: typeof send) => {
      send = replacement;
    },
    disconnect: () => {
      connected = false;
      raw.destroyed = true;
      raw.writable = false;
      close?.();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClientSseSender", () => {
  it("removes each close waiter after a successful write", async () => {
    const connection = createConnection();

    for (let index = 0; index < 1_000; index++) {
      await connection.sender.send({ event: "delta", data: { index } });
      expect(connection.sender.pendingWriteCount).toBe(0);
    }
  });

  it("releases a backpressured write when the client disconnects", async () => {
    const connection = createConnection();
    connection.setSend(() => new Promise<void>(() => undefined));

    const write = connection.sender.send({ event: "delta", data: { text: "pending" } });
    expect(connection.sender.pendingWriteCount).toBe(1);

    connection.disconnect();

    await expect(write).rejects.toBeInstanceOf(ClientStreamClosedError);
    expect(connection.sender.pendingWriteCount).toBe(0);
    await expect(
      connection.sender.send({ event: "delta", data: { text: "late" } }),
    ).rejects.toBeInstanceOf(ClientStreamClosedError);
  });

  it("propagates a send failure while the connection remains open", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    const failure = new Error("write failed");
    connection.setSend(() => Promise.reject(failure));

    await expect(connection.sender.send({ event: "error", data: {} })).rejects.toBe(failure);
    expect(connection.sender.pendingWriteCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends comment heartbeats before the first data frame and disposes them", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    await vi.advanceTimersByTimeAsync(19);
    expect(connection.raw.write).not.toHaveBeenCalled();
    expect(connection.raw.headersSent).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.raw.write).toHaveBeenCalledExactlyOnceWith(": ping\n\n");
    expect(connection.header).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(connection.header).toHaveBeenCalledWith("X-Accel-Buffering", "no");
    expect(connection.raw.flushHeaders).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.raw.write).toHaveBeenCalledTimes(2);
    connection.sender.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).toHaveBeenCalledTimes(2);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the idle deadline after every real data frame", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    for (let index = 0; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(15);
      await connection.sender.send({ data: { index } });
    }
    await vi.advanceTimersByTimeAsync(19);
    expect(connection.raw.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.raw.write).toHaveBeenCalledExactlyOnceWith(": ping\n\n");
    await vi.advanceTimersByTimeAsync(10);
    await connection.sender.send("resumed");
    await vi.advanceTimersByTimeAsync(19);
    expect(connection.raw.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.raw.write).toHaveBeenCalledTimes(2);
    connection.sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not create a heartbeat timer when disabled", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 0 });
    await connection.sender.send("first");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connection.raw.write).not.toHaveBeenCalled();
    connection.sender.dispose();
  });

  it("does not let Anthropic protocol pings reset the comment heartbeat deadline", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(5);
      await connection.sender.send(
        { event: "ping", data: { type: "ping" } },
        { resetHeartbeat: false },
      );
    }
    expect(connection.raw.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(connection.raw.write).toHaveBeenCalledExactlyOnceWith(": ping\n\n");
    connection.sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "disconnect",
    "abort",
    "dispose",
  ])("cleans up on %s before the first frame", async (reason) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    if (reason === "disconnect") connection.disconnect();
    else if (reason === "abort") abort.abort();
    else connection.sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    expect(connection.raw.headersSent).toBe(false);
  });

  it("stops heartbeats after an error frame even without cancellation", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await connection.sender.sendError({ event: "error", data: { type: "error" } });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).toHaveBeenCalledOnce();
    connection.sender.dispose();
  });

  it("skips heartbeats while a data write is pending and resumes after drain", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    const drained = Promise.withResolvers<void>();
    connection.setSend(() => drained.promise);
    const pending = connection.sender.send("blocked");
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    drained.resolve();
    await pending;
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.raw.write).toHaveBeenCalledOnce();
    connection.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not queue more heartbeats when a heartbeat itself becomes backpressured", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    connection.raw.write.mockImplementation(() => {
      connection.raw.writableNeedDrain = true;
      return false;
    });
    await connection.sender.send("first");
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).toHaveBeenCalledOnce();
    connection.raw.writableNeedDrain = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.raw.write).toHaveBeenCalledTimes(2);
    connection.disconnect();
  });

  it("stops heartbeats on cancellation while still allowing an error frame on a healthy connection", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    const failure = new Error("Request timed out");
    abort.abort(failure);
    await expect(connection.sender.send("late data")).rejects.toBe(failure);
    const send = vi.fn(async () => undefined);
    connection.setSend(send);
    await connection.sender.sendError({ event: "error", data: { type: "error" } });
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    expect(connection.raw.destroy).not.toHaveBeenCalled();
    connection.sender.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a pending write and closes the socket when the request is cancelled", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    connection.setSend(() => new Promise<void>(() => undefined));
    const pending = connection.sender.send("blocked");
    const rejected = expect(pending).rejects.toBeInstanceOf(ClientStreamClosedError);
    abort.abort();
    await rejected;
    expect(connection.raw.destroy).toHaveBeenCalledOnce();
    expect(connection.sender.pendingWriteCount).toBe(0);
    await connection.sender.sendError({ event: "error", data: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a backpressured heartbeat on cancellation even without a pending data write", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    connection.raw.writableNeedDrain = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    abort.abort();
    expect(connection.raw.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hang on an error write that becomes blocked after cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    const connection = createConnection({ signal: abort.signal });
    connection.setSend(() => {
      connection.raw.writableNeedDrain = true;
      return new Promise<void>(() => undefined);
    });
    await connection.sender.sendError({ event: "error", data: {} });
    expect(connection.raw.destroy).toHaveBeenCalledOnce();
    expect(connection.sender.pendingWriteCount).toBe(0);
  });

  it("handles a failed heartbeat write without leaking its timer", async () => {
    vi.useFakeTimers();
    const connection = createConnection({ heartbeatIntervalMs: 20 });
    await connection.sender.send("first");
    connection.raw.write.mockImplementation(() => {
      throw new Error("write failed");
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
