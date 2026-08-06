export type PingedIteratorResult<T> =
  | { type: "item"; value: T }
  | { type: "ping" }
  | { type: "done" };

export class PingedIterator<T> {
  #readPending = false;
  #readResult: IteratorResult<T> | undefined;
  #readError?: unknown;
  #pingStarted = false;
  #pingDue = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  constructor(
    private readonly iterator: AsyncIterator<T>,
    private readonly intervalMs: number,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error("Ping interval must be a positive safe integer");
    }
  }

  async next(): Promise<PingedIteratorResult<T>> {
    this.#startRead();
    while (true) {
      if (this.#readError !== undefined) {
        throw this.#readError;
      }
      if (this.#readResult !== undefined) {
        const result = this.#readResult;
        this.#readResult = undefined;
        if (result.done) {
          return { type: "done" };
        }
        return { type: "item", value: result.value };
      }
      if (this.#pingDue) {
        this.#pingDue = false;
        return { type: "ping" };
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }

  markClientWrite(): void {
    this.#pingStarted = true;
    this.#pingDue = false;
    this.#resetTimer();
  }

  close(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    void this.iterator.return?.();
  }

  #startRead(): void {
    if (this.#readPending) {
      return;
    }
    this.#readPending = true;
    void this.iterator.next().then(
      (result) => {
        this.#readPending = false;
        this.#readResult = result;
        this.#notify();
      },
      (error: unknown) => {
        this.#readPending = false;
        this.#readError = error;
        this.#notify();
      },
    );
  }

  #resetTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#pingStarted) {
        this.#pingDue = true;
        this.#notify();
      }
    }, this.intervalMs);
    this.#timer.unref();
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
