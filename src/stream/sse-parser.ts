export interface SseEvent {
  event: string;
  data: string;
}

export interface SseStreamTimeoutOptions {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  onTimeout?: (error: SseStreamTimeoutError) => void;
}

export interface SseParserLimits {
  maxFrameBytes: number;
}

export class SseFrameLimitError extends Error {
  override readonly name = "SseFrameLimitError";

  constructor(readonly limitBytes: number) {
    super("Upstream SSE frame exceeds the configured byte limit");
  }
}

export class SseStreamTimeoutError extends Error {
  readonly phase: "first-byte" | "idle";

  constructor(phase: "first-byte" | "idle") {
    super(`Upstream SSE ${phase} timeout`);
    this.name = "SseStreamTimeoutError";
    this.phase = phase;
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  timeoutOptions?: SseStreamTimeoutOptions,
  signal?: AbortSignal,
  limits?: SseParserLimits,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abortError = new Error("SSE stream aborted");
  const onAbort = () => {
    void reader.cancel(abortError).catch(() => undefined);
  };
  let buffer = "";
  let bufferedBytes = 0;
  let receivedBytes = false;
  let reachedEof = false;

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (true) {
      const phase = receivedBytes ? "idle" : "first-byte";
      const timeoutMs =
        phase === "first-byte" ? timeoutOptions?.firstByteTimeoutMs : timeoutOptions?.idleTimeoutMs;
      const { value, done } =
        timeoutMs === undefined
          ? await reader.read()
          : await readWithTimeout(reader, timeoutMs, phase, timeoutOptions?.onTimeout);
      if (value && value.byteLength > 0) {
        receivedBytes = true;
        bufferedBytes += value.byteLength;
      }
      try {
        buffer += decoder.decode(value, { stream: !done });
      } catch {
        throw new Error("Upstream SSE stream is not valid UTF-8");
      }

      let boundary = findBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        const consumed = buffer.slice(0, boundary.index + boundary.length);
        const frameBytes = Buffer.byteLength(frame, "utf8");
        assertFrameLimit(frameBytes, limits);
        buffer = buffer.slice(boundary.index + boundary.length);
        bufferedBytes -= Buffer.byteLength(consumed, "utf8");
        const event = parseFrame(frame);
        if (event) {
          yield event;
        }
        boundary = findBoundary(buffer);
      }
      assertFrameLimit(bufferedBytes, limits);

      if (done) {
        reachedEof = true;
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!reachedEof) {
      await reader
        .cancel(new Error("SSE stream consumption stopped before EOF"))
        .catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  phase: "first-byte" | "idle",
  onTimeout?: (error: SseStreamTimeoutError) => void,
): Promise<{ value?: Uint8Array; done: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new SseStreamTimeoutError(phase);
      onTimeout?.(error);
      reject(error);
      void reader.cancel(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertFrameLimit(frameBytes: number, limits: SseParserLimits | undefined): void {
  if (limits && frameBytes > limits.maxFrameBytes) {
    throw new SseFrameLimitError(limits.maxFrameBytes);
  }
}

function findBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseFrame(frame: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}
