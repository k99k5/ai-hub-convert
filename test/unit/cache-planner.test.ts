import { describe, expect, it } from "vitest";
import {
  type PromptCacheInput,
  planPromptCacheBreakpoints,
} from "../../src/policies/cache/planner.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe("planPromptCacheBreakpoints", () => {
  it("returns only explicit breakpoints in tools, system, messages order when disabled", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [{ id: "tool:0" }, { id: "tool:1", explicitBreakpoint: true }],
      system: [{ id: "system:0", explicitBreakpoint: true }],
      messages: [{ id: "message:0", explicitBreakpoint: true }, { id: "message:1" }],
    });

    expect(planPromptCacheBreakpoints(input, { enabled: false })).toEqual([
      {
        nodeId: "tool:1",
        source: "explicit",
        section: "tools",
        reason: "explicit breakpoint",
      },
      {
        nodeId: "system:0",
        source: "explicit",
        section: "system",
        reason: "explicit breakpoint",
      },
      {
        nodeId: "message:0",
        source: "explicit",
        section: "messages",
        reason: "explicit breakpoint",
      },
    ]);
  });

  it("prioritizes explicit breakpoints before automatic candidates within four slots", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [{ id: "tool:0", explicitBreakpoint: true }, { id: "tool:1" }],
      system: [{ id: "system:0", explicitBreakpoint: true }, { id: "system:1" }],
      messages: [{ id: "message:0" }, { id: "message:1" }],
    });

    expect(planPromptCacheBreakpoints(input, { enabled: true })).toEqual([
      {
        nodeId: "tool:0",
        source: "explicit",
        section: "tools",
        reason: "explicit breakpoint",
      },
      {
        nodeId: "system:0",
        source: "explicit",
        section: "system",
        reason: "explicit breakpoint",
      },
      {
        nodeId: "tool:1",
        source: "automatic",
        section: "tools",
        reason: "last tool",
      },
      {
        nodeId: "system:1",
        source: "automatic",
        section: "system",
        reason: "last system block",
      },
    ]);
  });

  it("uses tool, system, then historical message boundary automatic priority", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [{ id: "tool:0" }, { id: "tool:1" }],
      system: [{ id: "system:0" }, { id: "system:1" }],
      messages: [{ id: "message:0" }, { id: "message:1" }, { id: "message:2" }],
    });

    expect(planPromptCacheBreakpoints(input, { enabled: true })).toEqual([
      {
        nodeId: "tool:1",
        source: "automatic",
        section: "tools",
        reason: "last tool",
      },
      {
        nodeId: "system:1",
        source: "automatic",
        section: "system",
        reason: "last system block",
      },
      {
        nodeId: "message:1",
        source: "automatic",
        section: "messages",
        reason: "historical message boundary",
      },
    ]);
  });

  it("never automatically chooses the current message tail", () => {
    const oneMessage = deepFreeze<PromptCacheInput>({
      tools: [],
      system: [],
      messages: [{ id: "message:0" }],
    });
    const movingTail = deepFreeze<PromptCacheInput>({
      tools: [],
      system: [],
      messages: [{ id: "message:0" }, { id: "message:1" }],
    });

    expect(planPromptCacheBreakpoints(oneMessage, { enabled: true })).toEqual([]);
    expect(planPromptCacheBreakpoints(movingTail, { enabled: true })).toEqual([
      {
        nodeId: "message:0",
        source: "automatic",
        section: "messages",
        reason: "historical message boundary",
      },
    ]);
  });

  it("keeps positional IDs distinct across sections and never mutates frozen input", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [{ id: "tool:0", explicitBreakpoint: true }],
      system: [{ id: "system:0", explicitBreakpoint: true }],
      messages: [{ id: "message:0", explicitBreakpoint: true }, { id: "message:1" }],
    });

    expect(() => planPromptCacheBreakpoints(input, { enabled: false })).not.toThrow();
    expect(
      planPromptCacheBreakpoints(input, { enabled: false }).map(({ nodeId }) => nodeId),
    ).toEqual(["tool:0", "system:0", "message:0"]);
  });

  it("never exceeds the hard limit of four breakpoints", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [
        { id: "tool:0", explicitBreakpoint: true },
        { id: "tool:1", explicitBreakpoint: true },
      ],
      system: [
        { id: "system:0", explicitBreakpoint: true },
        { id: "system:1", explicitBreakpoint: true },
      ],
      messages: [{ id: "message:0", explicitBreakpoint: true }, { id: "message:1" }],
    });

    expect(planPromptCacheBreakpoints(input, { enabled: true, maxBreakpoints: 10 })).toHaveLength(
      4,
    );
  });

  it("uses the available slots for explicit breakpoints before automatic candidates", () => {
    const input = deepFreeze<PromptCacheInput>({
      tools: [
        { id: "tool:0", explicitBreakpoint: true },
        { id: "tool:1", explicitBreakpoint: true },
      ],
      system: [{ id: "system:0", explicitBreakpoint: true }],
      messages: [{ id: "message:0", explicitBreakpoint: true }, { id: "message:1" }],
    });

    expect(planPromptCacheBreakpoints(input, { enabled: true, maxBreakpoints: 2 })).toEqual([
      {
        nodeId: "tool:0",
        source: "explicit",
        section: "tools",
        reason: "explicit breakpoint",
      },
      {
        nodeId: "tool:1",
        source: "explicit",
        section: "tools",
        reason: "explicit breakpoint",
      },
    ]);
  });
});
