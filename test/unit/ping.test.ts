import { afterEach, describe, expect, it, vi } from "vitest";
import { PingedIterator } from "../../src/stream/ping.js";

interface ControlledIterator<T> extends AsyncIterator<T> {
  resolve(result: IteratorResult<T>): void;
}

function controlledIterator<T>(): ControlledIterator<T> {
  let resolveNext: ((result: IteratorResult<T>) => void) | undefined;
  return {
    next: () =>
      new Promise<IteratorResult<T>>((resolve) => {
        resolveNext = resolve;
      }),
    resolve: (result) => {
      if (!resolveNext) {
        throw new Error("Iterator read has not started");
      }
      const resolve = resolveNext;
      resolveNext = undefined;
      resolve(result);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PingedIterator", () => {
  it("does not emit a ping before the first client write", async () => {
    vi.useFakeTimers();
    const source = controlledIterator<string>();
    const iterator = new PingedIterator(source, 10);
    const next = iterator.next();
    let settled = false;
    void next.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);

    source.resolve({ done: false, value: "first" });
    await expect(next).resolves.toEqual({ type: "item", value: "first" });
    iterator.close();
  });

  it("closes the wrapped iterator during cleanup", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator = new PingedIterator<string>(
      {
        next: async () => ({ done: true, value: undefined }),
        return: close,
      },
      10,
    );

    await iterator.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("emits one ping after the client stream becomes idle", async () => {
    vi.useFakeTimers();
    const source = controlledIterator<string>();
    const iterator = new PingedIterator(source, 10);
    iterator.markClientWrite();
    const next = iterator.next();

    await vi.advanceTimersByTimeAsync(10);
    await expect(next).resolves.toEqual({ type: "ping" });

    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(50);
    source.resolve({ done: true, value: undefined });
    await expect(pending).resolves.toEqual({ type: "done" });
    iterator.close();
  });
});
