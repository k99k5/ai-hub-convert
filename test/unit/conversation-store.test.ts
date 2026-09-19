import { describe, expect, it } from "vitest";
import { ConversationError, ConversationStore } from "../../src/policies/conversation-store.js";

const item = (id: string, text = "hello") => ({ id, type: "message", role: "user", content: text });

describe("ConversationStore", () => {
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
