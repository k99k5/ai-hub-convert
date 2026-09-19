import { describe, expect, it } from "vitest";
import { ConversationError, ConversationStore } from "../../src/policies/conversation-store.js";

const item = (id: string, text = "hello") => ({ id, type: "message", role: "user", content: text });

describe("ConversationStore", () => {
  it("expires after thirty idle minutes and renews on reads and writes", () => {
    let now = 0;
    const ttl = 30 * 60_000;
    const store = new ConversationStore({ now: () => now });
    const conversation = store.create("key", {}, [item("msg_1")]);
    now = ttl - 1;
    expect(store.retrieve("key", conversation.id).id).toBe(conversation.id);
    now += ttl - 1;
    expect(store.items("key", conversation.id)).toEqual([item("msg_1")]);
    now += ttl - 1;
    store.update("key", conversation.id, { topic: "still active" });
    now += ttl - 1;
    store.append("key", conversation.id, [item("msg_2")]);
    now += ttl - 1;
    store.deleteItem("key", conversation.id, "msg_1");
    now += ttl;
    for (const operation of [
      () => store.retrieve("key", conversation.id),
      () => store.items("key", conversation.id),
      () => store.update("key", conversation.id, {}),
      () => store.append("key", conversation.id, []),
      () => store.begin("key", conversation.id),
    ])
      expect(operation).toThrowError(expect.objectContaining({ code: "conversation_not_found" }));
  });

  it("does not renew a conversation accessed with another credential", () => {
    let now = 0;
    const store = new ConversationStore({ ttlMs: 100, now: () => now });
    const conversation = store.create("key-a", {}, []);
    now = 99;
    expect(() => store.retrieve("key-b", conversation.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    now = 100;
    expect(() => store.retrieve("key-a", conversation.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it.each([
    { maxCredentialEntries: 1 },
    { maxEntries: 1 },
    { maxCredentialBytes: 1000 },
    { maxBytes: 1000 },
  ])("reclaims expired capacity before creating another conversation: %j", (limits) => {
    let now = 0;
    const store = new ConversationStore({ ...limits, ttlMs: 100, now: () => now });
    const first = store.create("key", {}, []);
    expect(() => store.create("key", {}, [])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    now = 100;
    const second = store.create("key", {}, []);
    expect(() => store.retrieve("key", first.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    store.prune();
    store.prune();
    expect(() => store.create("key", {}, [])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    now = 200;
    store.prune();
    expect(() => store.retrieve("key", second.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.create("key", {}, [])).toHaveProperty("object", "conversation");
  });

  it.each([
    false,
    true,
  ])("protects active turns and restarts idle time on release, commit=%s", (commit) => {
    let now = 0;
    const store = new ConversationStore({ ttlMs: 100, maxEntries: 1, now: () => now });
    const conversation = store.create("key", {}, []);
    const turn = store.begin("key", conversation.id);
    turn.stage([item("msg_1")]);
    now = 1000;
    store.prune();
    expect(() => store.create("other-key", {}, [])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    if (commit) turn.commit([item("msg_2")]);
    now = 1500;
    store.prune();
    turn.release();
    expect(store.items("key", conversation.id)).toHaveLength(commit ? 2 : 0);
    now = 1599;
    turn.release();
    store.prune();
    expect(() => store.create("other-key", {}, [])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    now = 1600;
    store.prune();
    expect(() => store.retrieve("key", conversation.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.create("other-key", {}, [])).toHaveProperty("object", "conversation");
  });

  it("frees expired histories before committing an active turn that needs their byte budget", () => {
    let now = 0;
    const store = new ConversationStore({
      ttlMs: 100,
      maxCredentialBytes: 1800,
      maxBytes: 1800,
      now: () => now,
    });
    const expired = store.create("key", {}, [item("msg_old", "x".repeat(500))]);
    const active = store.create("key", {}, []);
    const turn = store.begin("key", active.id);
    const output = [item("msg_new", "x".repeat(500))];
    expect(() => turn.commit(output)).toThrowError(expect.objectContaining({ status: 429 }));
    now = 100;
    turn.commit(output);
    turn.release();
    expect(store.items("key", active.id)).toEqual(output);
    expect(() => store.retrieve("key", expired.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid idle timeouts: %s", (ttlMs) => {
    expect(() => new ConversationStore({ ttlMs })).toThrow(/positive safe integer/);
  });

  it("isolates credentials, snapshots returned data, and clears all state on shutdown", () => {
    const store = new ConversationStore();
    const input = item("msg_1");
    const first = store.create("key-a", { topic: "first" }, [input]);
    input.content = "changed";
    first.metadata.topic = "changed";
    const returned = store.items("key-a", first.id)[0];
    if (!returned) throw new Error("Expected the initial conversation item");
    returned.content = "changed";
    expect(store.items("key-a", first.id)).toEqual([item("msg_1")]);
    expect(store.retrieve("key-a", first.id).metadata).toEqual({ topic: "first" });
    expect(() => store.begin("key-b", first.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => store.delete("key-b", first.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    const turn = store.begin("key-a", first.id);
    store.clear();
    expect(() => turn.commit([])).toThrowError(expect.objectContaining({ status: 409 }));
    turn.release();
    expect(() => store.retrieve("key-a", first.id)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("commits turns atomically, rejects conflicting writes, and releases aborted turns", () => {
    const store = new ConversationStore();
    const conversation = store.create("key", {}, [item("msg_1")]);
    const turn = store.begin("key", conversation.id);
    turn.stage([item("msg_2")]);
    expect(store.items("key", conversation.id)).toHaveLength(1);
    for (const operation of [
      () => store.begin("key", conversation.id),
      () => store.update("key", conversation.id, {}),
      () => store.delete("key", conversation.id),
      () => store.append("key", conversation.id, [item("msg_3")]),
      () => store.deleteItem("key", conversation.id, "msg_1"),
    ])
      expect(operation).toThrowError(expect.objectContaining({ code: "conversation_busy" }));
    turn.release();
    turn.release();
    expect(store.items("key", conversation.id)).toHaveLength(1);
    const retry = store.begin("key", conversation.id);
    retry.stage([item("msg_2")]);
    retry.commit([item("msg_3")]);
    expect(() => retry.commit([])).toThrowError(
      expect.objectContaining({ code: "conversation_conflict" }),
    );
    retry.release();
    expect(store.items("key", conversation.id).map((value) => value.id)).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
    ]);
    expect(store.deleteItem("key", conversation.id, "msg_2")).toHaveProperty(
      "object",
      "conversation",
    );
    expect(() => store.deleteItem("key", conversation.id, "missing")).toThrowError(
      expect.objectContaining({ code: "item_not_found" }),
    );
    expect(store.delete("key", conversation.id)).toEqual({
      id: conversation.id,
      object: "conversation.deleted",
      deleted: true,
    });
  });

  it("rejects duplicate IDs and oversized commits without changing saved history", () => {
    const store = new ConversationStore({ maxConversationBytes: 1400, maxItems: 3 });
    const conversation = store.create("key", {}, [item("msg_1")]);
    expect(() => store.append("key", conversation.id, [item("msg_1")])).toThrowError(
      expect.objectContaining({ code: "duplicate_item_id" }),
    );
    const turn = store.begin("key", conversation.id);
    turn.stage([item("msg_2")]);
    expect(() => turn.commit([item("msg_3", "x".repeat(1500))])).toThrowError(
      expect.objectContaining({ code: "conversation_too_large" }),
    );
    turn.release();
    expect(store.items("key", conversation.id)).toEqual([item("msg_1")]);
    expect(() =>
      store.append("key", conversation.id, [item("msg_2"), item("msg_3"), item("msg_4")]),
    ).toThrowError(expect.objectContaining({ status: 413 }));
  });

  it("accounts for updates and deletions without evicting other conversations", () => {
    const store = new ConversationStore({
      maxCredentialBytes: 1200,
      maxBytes: 1800,
      maxConversationBytes: 1800,
    });
    const first = store.create("key-a", {}, [item("msg_1")]);
    const second = store.create("key-b", {}, []);
    expect(() => store.append("key-a", first.id, [item("msg_2", "x".repeat(700))])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    expect(store.items("key-a", first.id)).toHaveLength(1);
    expect(() => store.create("key-c", {}, [item("msg_3", "x".repeat(500))])).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
    store.delete("key-b", second.id);
    expect(store.create("key-c", {}, [item("msg_3", "x".repeat(300))])).toHaveProperty(
      "object",
      "conversation",
    );
    expect(store.update("key-a", first.id, { topic: "new" }).metadata).toEqual({ topic: "new" });
    expect(store.update("key-a", first.id, undefined).metadata).toEqual({ topic: "new" });
  });

  it("bounds conversation counts per key and globally", () => {
    const store = new ConversationStore({ maxCredentialEntries: 1, maxEntries: 2 });
    const first = store.create("a", {}, []);
    store.create("b", {}, []);
    expect(() => store.create("a", {}, [])).toThrow(ConversationError);
    expect(() => store.create("c", {}, [])).toThrow(ConversationError);
    store.delete("a", first.id);
    expect(store.create("c", {}, [])).toHaveProperty("object", "conversation");
    expect(() => new ConversationStore({ maxBytes: 0 })).toThrow(/positive safe integer/);
  });
});
