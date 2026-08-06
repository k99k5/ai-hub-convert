export interface StreamOutputLimits {
  perItemBytes: number;
  perStreamBytes: number;
}

export const DEFAULT_STREAM_OUTPUT_LIMITS: StreamOutputLimits = {
  perItemBytes: 8 * 1024 * 1024,
  perStreamBytes: 32 * 1024 * 1024,
};

export class StreamOutputLimitError extends Error {
  override readonly name = "StreamOutputLimitError";
  readonly code = "STREAM_OUTPUT_TOO_LARGE";

  constructor(
    readonly scope: "item" | "stream",
    readonly limitBytes: number,
  ) {
    super("Stream output exceeds the configured byte limit");
  }
}

interface ItemState {
  bytes: number;
  trailingHighSurrogate: boolean;
}

export class StreamOutputLimiter {
  readonly #items = new Map<number, ItemState>();
  #streamBytes = 0;

  constructor(private readonly limits: StreamOutputLimits = DEFAULT_STREAM_OUTPUT_LIMITS) {
    assertPositiveSafeInteger(limits.perItemBytes, "per-item stream output limit");
    assertPositiveSafeInteger(limits.perStreamBytes, "per-stream output limit");
  }

  add(index: number, value: string): void {
    const state = this.#items.get(index) ?? { bytes: 0, trailingHighSurrogate: false };
    const correction = state.trailingHighSurrogate && startsWithLowSurrogate(value) ? 2 : 0;
    this.#add(index, Buffer.byteLength(value, "utf8") - correction, state);
    if (value.length > 0) {
      state.trailingHighSurrogate = isHighSurrogate(value.charCodeAt(value.length - 1));
    }
  }

  addUnrelated(index: number, value: string): void {
    this.addBytes(index, Buffer.byteLength(value, "utf8"));
  }

  addBytes(index: number, bytes: number): void {
    const state = this.#items.get(index) ?? { bytes: 0, trailingHighSurrogate: false };
    this.#add(index, bytes, state);
  }

  #add(index: number, bytes: number, state: ItemState): void {
    const itemBytes = state.bytes + bytes;
    if (itemBytes > this.limits.perItemBytes) {
      throw new StreamOutputLimitError("item", this.limits.perItemBytes);
    }
    const streamBytes = this.#streamBytes + bytes;
    if (streamBytes > this.limits.perStreamBytes) {
      throw new StreamOutputLimitError("stream", this.limits.perStreamBytes);
    }
    state.bytes = itemBytes;
    this.#items.set(index, state);
    this.#streamBytes = streamBytes;
  }
}

function startsWithLowSurrogate(value: string): boolean {
  return value.length > 0 && isLowSurrogate(value.charCodeAt(0));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
