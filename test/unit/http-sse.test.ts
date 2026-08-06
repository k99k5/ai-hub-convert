import { describe, expect, it } from "vitest";
import { ClientSseSender, ClientStreamClosedError } from "../../src/http/sse.js";

function createConnection() {
  let connected = true;
  let close: (() => void) | undefined;
  let send = async (_frame: unknown): Promise<void> => undefined;
  const raw = { writableEnded: false, destroyed: false, writable: true };
  const sender = new ClientSseSender({
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
  });

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
});
