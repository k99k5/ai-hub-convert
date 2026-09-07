import { describe, expect, it } from "vitest";
import {
  createWebSearchReplayToken,
  createWebSearchToolUseId,
} from "../../src/providers/web-search/internal.js";

describe("Web Search replay token", () => {
  it("is stable, opaque, and does not embed the search payload", () => {
    const query = "2026年国庆节放假安排";
    const result = {
      title: "国务院办公厅通知",
      url: "https://example.test/holiday",
    };

    const first = createWebSearchReplayToken(0, 0, query, result);
    const second = createWebSearchReplayToken(0, 0, query, result);

    expect(second).toBe(first);
    expect(first).toMatch(/^ai_hub_replay_v1:[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(query);
    expect(first).not.toContain(result.title);
    expect(first).not.toContain(result.url);
  });

  it("derives distinct server-tool IDs for the same execution id in different responses", () => {
    const first = createWebSearchToolUseId("resp_turn_1", "call_search", 0);
    const second = createWebSearchToolUseId("resp_turn_2", "call_search", 0);

    expect(first).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^srvtoolu_ai_hub_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect(createWebSearchToolUseId("resp_turn_1", "call_search", 0)).toBe(first);
  });
});
