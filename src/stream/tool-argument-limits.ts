export interface ToolArgumentLimits {
  perCallBytes: number;
  perStreamBytes: number;
}

export const DEFAULT_TOOL_ARGUMENT_LIMITS: ToolArgumentLimits = {
  perCallBytes: 1024 * 1024,
  perStreamBytes: 8 * 1024 * 1024,
};

export class ToolArgumentLimitError extends Error {
  readonly code = "TOOL_ARGUMENTS_TOO_LARGE";

  constructor(readonly scope: "call" | "stream") {
    super(`Tool arguments exceed the ${scope === "call" ? "per-call" : "per-stream"} byte limit`);
    this.name = "ToolArgumentLimitError";
  }
}

interface CallState {
  bytes: number;
  trailingHighSurrogate: boolean;
}

export class ToolArgumentStreamLimiter {
  readonly #calls = new Map<number, CallState>();
  #streamBytes = 0;

  constructor(private readonly limits: ToolArgumentLimits) {
    assertPositiveSafeInteger(limits.perCallBytes, "per-call tool argument limit");
    assertPositiveSafeInteger(limits.perStreamBytes, "per-stream tool argument limit");
  }

  add(callIndex: number, delta: string): void {
    const state = this.#calls.get(callIndex) ?? { bytes: 0, trailingHighSurrogate: false };
    const correction = state.trailingHighSurrogate && startsWithLowSurrogate(delta) ? 2 : 0;
    const addedBytes = Buffer.byteLength(delta, "utf8") - correction;
    const callBytes = state.bytes + addedBytes;
    const streamBytes = this.#streamBytes + addedBytes;

    if (callBytes > this.limits.perCallBytes) {
      throw new ToolArgumentLimitError("call");
    }
    if (streamBytes > this.limits.perStreamBytes) {
      throw new ToolArgumentLimitError("stream");
    }

    state.bytes = callBytes;
    if (delta.length > 0) {
      state.trailingHighSurrogate = isHighSurrogate(delta.charCodeAt(delta.length - 1));
    }
    this.#calls.set(callIndex, state);
    this.#streamBytes = streamBytes;
  }

  finish(callIndex: number): void {
    this.#calls.delete(callIndex);
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
