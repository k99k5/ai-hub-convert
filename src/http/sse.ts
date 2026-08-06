import type { SSEReplyInterface, SSESource } from "@fastify/sse";

interface SseRawResponse {
  writableEnded: boolean;
  destroyed: boolean;
  writable: boolean;
}

interface SseConnection {
  raw: SseRawResponse;
  sse: Pick<SSEReplyInterface, "isConnected" | "onClose" | "send" | "close">;
}

export class ClientStreamClosedError extends Error {
  override readonly name = "ClientStreamClosedError";
}

export class ClientSseSender {
  readonly #connection: SseConnection;
  readonly #pendingWrites = new Set<() => void>();

  constructor(connection: SseConnection) {
    this.#connection = connection;
    connection.sse.onClose(() => {
      for (const closeWrite of this.#pendingWrites) {
        closeWrite();
      }
      this.#pendingWrites.clear();
    });
  }

  get pendingWriteCount(): number {
    return this.#pendingWrites.size;
  }

  readonly send = async (frame: SSESource): Promise<void> => {
    if (!this.#isWritable()) {
      throw new ClientStreamClosedError("Client SSE connection is closed");
    }

    const writeClosed = Promise.withResolvers<"closed">();
    const closeWrite = () => writeClosed.resolve("closed");
    this.#pendingWrites.add(closeWrite);
    try {
      const outcome = await Promise.race([
        this.#connection.sse.send(frame).then(() => "sent" as const),
        writeClosed.promise,
      ]);
      if (outcome === "closed" || !this.#isWritable()) {
        throw new ClientStreamClosedError("Client SSE connection closed during write");
      }
    } finally {
      this.#pendingWrites.delete(closeWrite);
    }
  };

  async sendError(frame: SSESource): Promise<void> {
    if (!this.#isWritable()) {
      return;
    }
    try {
      await this.send(frame);
    } catch {
      this.#connection.sse.close();
    }
  }

  #isWritable(): boolean {
    return (
      this.#connection.sse.isConnected &&
      !this.#connection.raw.writableEnded &&
      !this.#connection.raw.destroyed &&
      this.#connection.raw.writable
    );
  }
}
