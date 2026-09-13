import type { SSEReplyInterface, SSESource } from "@fastify/sse";

interface SseRawResponse {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  writable: boolean;
  writableNeedDrain: boolean;
  write(chunk: string): boolean;
  destroy(): unknown;
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
  readonly #signal: AbortSignal | undefined;
  readonly #heartbeatIntervalMs: number;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(
    connection: SseConnection,
    options: { signal?: AbortSignal; heartbeatIntervalMs?: number } = {},
  ) {
    this.#connection = connection;
    this.#signal = options.signal;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
    connection.sse.onClose(() => {
      this.dispose();
      this.#releasePendingWrites();
    });
    if (this.#signal?.aborted) this.#onAbort();
    else this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  get pendingWriteCount(): number {
    return this.#pendingWrites.size;
  }

  readonly send = async (frame: SSESource): Promise<void> => {
    this.#signal?.throwIfAborted();
    await this.#sendFrame(frame);
  };

  async #sendFrame(frame: SSESource): Promise<void> {
    if (!this.#isWritable()) {
      throw new ClientStreamClosedError("Client SSE connection is closed");
    }

    const writeClosed = Promise.withResolvers<"closed">();
    const closeWrite = () => writeClosed.resolve("closed");
    this.#pendingWrites.add(closeWrite);
    try {
      const sent = this.#connection.sse.send(frame);
      // Error frames can be sent after cancellation, but must not start another
      // unbounded wait for drain after the abort event has already fired.
      if (this.#signal?.aborted && this.#connection.raw.writableNeedDrain) {
        this.#destroyConnection();
      }
      const outcome = await Promise.race([sent.then(() => "sent" as const), writeClosed.promise]);
      if (outcome === "closed" || !this.#isWritable()) {
        throw new ClientStreamClosedError("Client SSE connection closed during write");
      }
      this.#startHeartbeat();
    } finally {
      this.#pendingWrites.delete(closeWrite);
    }
  }

  async sendError(frame: SSESource): Promise<void> {
    if (!this.#isWritable()) {
      return;
    }
    if (this.#connection.raw.writableNeedDrain) {
      this.#destroyConnection();
      return;
    }
    try {
      await this.#sendFrame(frame);
    } catch {
      this.#destroyConnection();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopHeartbeat();
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  readonly #onAbort = (): void => {
    this.#stopHeartbeat();
    // A writable connection can still receive its protocol-native error frame.
    // A stalled connection must be destroyed so pending sends and shutdown finish.
    if (this.#pendingWrites.size > 0 || this.#connection.raw.writableNeedDrain) {
      this.#destroyConnection();
    }
  };

  #destroyConnection(): void {
    this.dispose();
    if (!this.#connection.raw.destroyed) this.#connection.raw.destroy();
    this.#releasePendingWrites();
  }

  #releasePendingWrites(): void {
    for (const closeWrite of this.#pendingWrites) closeWrite();
    this.#pendingWrites.clear();
  }

  #startHeartbeat(): void {
    if (
      this.#disposed ||
      this.#signal?.aborted ||
      this.#heartbeatIntervalMs === 0 ||
      this.#heartbeatTimer !== undefined
    )
      return;
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#isWritable() || this.#signal?.aborted) {
        this.#stopHeartbeat();
        return;
      }
      const raw = this.#connection.raw;
      if (!raw.headersSent || raw.writableNeedDrain || this.#pendingWrites.size > 0) return;
      try {
        // If this write fills the buffer, writableNeedDrain suppresses subsequent ticks.
        raw.write(": heartbeat\n\n");
      } catch {
        this.#destroyConnection();
      }
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref();
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
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
