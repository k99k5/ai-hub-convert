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
    write: vi.fn((_frame: string) => true),
    destroy: vi.fn(() => {
      connected = false;
      raw.destroyed = true;
      raw.writable = false;
      close?.();
    }),
  };
  const sender = new ClientSseSender(
    {
      raw,
      sse: {
        get isConnected() {
          return connected;
        },
        onClose(callback) {
          close = callback;
        },
        send: (frame) => send(frame),
        close: () => {
          connected = false;
          close?.();
        },
      },
    },
    options,
  );

  return {
    raw,
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
    const connection = createConnection();
    const failure = new Error("write failed");
    connection.setSend(() => Promise.reject(failure));

    await expect(connection.sender.send({ event: "error", data: {} })).rejects.toBe(failure);
    expect(connection.sender.pendingWriteCount).toBe(0);
  });

  it("starts heartbeats only after a successful SSE write and disposes them", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const connection = createConnection({ signal: abort.signal, heartbeatIntervalMs: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).not.toHaveBeenCalled();
    await connection.sender.send("first");
    await vi.advanceTimersByTimeAsync(20);
    expect(connection.raw.write).toHaveBeenCalledExactlyOnceWith(": heartbeat\n\n");
    connection.sender.dispose();
    await vi.advanceTimersByTimeAsync(100);
    expect(connection.raw.write).toHaveBeenCalledOnce();
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
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
