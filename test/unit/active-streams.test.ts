import { describe, expect, it, vi } from "vitest";
import { ActiveStreamRegistry } from "../../src/stream/active-streams.js";

describe("ActiveStreamRegistry", () => {
  it("aborts every active stream during shutdown", () => {
    const registry = new ActiveStreamRegistry();
    const first = new AbortController();
    const second = new AbortController();

    registry.add(first);
    registry.add(second);
    registry.abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("does not abort a stream removed after normal completion", () => {
    const registry = new ActiveStreamRegistry();
    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");

    const remove = registry.add(controller);
    remove();
    registry.abortAll();

    expect(abort).not.toHaveBeenCalled();
  });
});
