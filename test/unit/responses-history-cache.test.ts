import { describe, expect, it } from "vitest";
import { ResponsesHistoryCache } from "../../src/policies/responses-history-cache.js";

const history = [
  { role: "user", content: "私有历史" },
  { role: "assistant", content: "回答" },
];

describe("Responses HTTP history cache", () => {
  it("isolates snapshots by credential and model, including identical response IDs", () => {
    const cache = new ResponsesHistoryCache();
    expect(cache.remember("key-a", "m", "resp_1", history)).toBe(true);
    expect(cache.resolve("key-b", "m", "resp_1")).toBeUndefined();
    expect(cache.resolve("key-a", "other", "resp_1")).toBeUndefined();
    cache.remember("key-b", "m", "resp_1", []);
    cache.remember("key-a", "other", "resp_1", ["other"]);
    expect(cache.resolve("key-a", "m", "resp_1")).toEqual(history);
    expect(cache.resolve("key-b", "m", "resp_1")).toEqual([]);
    expect(cache.resolve("key-a", "other", "resp_1")).toEqual(["other"]);
    expect(JSON.stringify(cache)).not.toContain("key-a");
    expect(cache.remember("key-a", "m", "", history)).toBe(false);
  });

  it("copies on write and read so forks cannot mutate their parents", () => {
    const cache = new ResponsesHistoryCache();
    const input = structuredClone(history);
    cache.remember("key", "m", "parent", input);
    (input[0] as (typeof history)[number]).content = "changed";
    const resolved = cache.resolve("key", "m", "parent") as typeof history;
    (resolved[0] as (typeof history)[number]).content = "also changed";
    resolved.push({ role: "user", content: "fork" });
    expect(cache.resolve("key", "m", "parent")).toEqual(history);
  });

  it("expires after five minutes without refreshing on reads or identical writes", () => {
    let now = 0;
    const cache = new ResponsesHistoryCache({ now: () => now });
    cache.remember("key", "m", "parent", history);
    now = 299_999;
    expect(cache.resolve("key", "m", "parent")).toEqual(history);
    expect(cache.remember("key", "m", "parent", history)).toBe(true);
    now = 300_000;
    expect(cache.resolve("key", "m", "parent")).toBeUndefined();
  });

  it("retains complete descendants after ancestors expire or are evicted", () => {
    let now = 0;
    const cache = new ResponsesHistoryCache({ ttlMs: 100, maxEntries: 2, now: () => now });
    cache.remember("key", "m", "parent", history);
    now = 50;
    const child = [
      ...(cache.resolve("key", "m", "parent") as unknown[]),
      { role: "user", content: "next" },
    ];
    cache.remember("key", "m", "child", child);
    cache.remember("key", "m", "unrelated", []);
    expect(cache.resolve("key", "m", "parent")).toBeUndefined();
    now = 100;
    cache.prune();
    expect(cache.resolve("key", "m", "child")).toEqual(child);
    now = 150;
    cache.prune();
    expect(cache.resolve("key", "m", "child")).toBeUndefined();
    expect(cache.remember("key", "m", "fresh", history)).toBe(true);
  });

  it("keeps conflicting IDs unreadable until their original expiry", () => {
    let now = 0;
    const cache = new ResponsesHistoryCache({ ttlMs: 100, now: () => now });
    cache.remember("key", "m", "collision", history);
    now = 50;
    expect(cache.remember("key", "m", "collision", ["different"])).toBe(false);
    expect(cache.resolve("key", "m", "collision")).toBeUndefined();
    expect(cache.remember("key", "m", "collision", history)).toBe(false);
    now = 100;
    expect(cache.remember("key", "m", "collision", history)).toBe(true);
    expect(cache.resolve("key", "m", "collision")).toEqual(history);
  });

  it.each([
    { maxCredentialEntries: 2 },
    { maxCredentialBytes: 1_000 },
  ])("evicts the oldest snapshot of the same credential: %j", (limits) => {
    const cache = new ResponsesHistoryCache(limits);
    cache.remember("other", "m", "private", []);
    cache.remember("key", "m", "old", []);
    cache.remember("key", "other-model", "new", []);
    cache.resolve("key", "m", "old");
    cache.remember("key", "m", "latest", []);
    expect(cache.resolve("key", "m", "old")).toBeUndefined();
    expect(cache.resolve("key", "other-model", "new")).toEqual([]);
    expect(cache.resolve("other", "m", "private")).toEqual([]);
  });

  it.each([{ maxEntries: 2 }, { maxBytes: 1_000 }])("bounds all credentials: %j", (limits) => {
    const cache = new ResponsesHistoryCache(limits);
    cache.remember("a", "m", "old", []);
    cache.remember("b", "m", "new", []);
    cache.remember("c", "m", "latest", []);
    expect(cache.resolve("a", "m", "old")).toBeUndefined();
    expect(cache.resolve("b", "m", "new")).toEqual([]);
    expect(cache.resolve("c", "m", "latest")).toEqual([]);
    cache.clear();
    expect(cache.resolve("b", "m", "new")).toBeUndefined();
    expect(cache.remember("b", "m", "fresh", history)).toBe(true);
  });

  it.each([
    { maxEntryBytes: 500 },
    { maxCredentialBytes: 500 },
    { maxBytes: 500 },
  ])("skips oversized UTF-8 snapshots without evicting usable history: %j", (limits) => {
    const cache = new ResponsesHistoryCache(limits);
    expect(cache.remember("key", "m", "keep", [])).toBe(true);
    expect(cache.remember("key", "m", "large", ["中".repeat(100)])).toBe(false);
    expect(cache.resolve("key", "m", "large")).toBeUndefined();
    expect(cache.resolve("key", "m", "keep")).toEqual([]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects unsafe limits: %s", (ttlMs) => {
    expect(() => new ResponsesHistoryCache({ ttlMs })).toThrow(/positive safe integer/);
  });
});
