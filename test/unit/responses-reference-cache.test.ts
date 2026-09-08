import { describe, expect, it } from "vitest";
import { ResponsesReferenceCache } from "../../src/policies/responses-reference-cache.js";

function message(id: string, text = "回答") {
  return { id, type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

describe("Responses 输出引用缓存", () => {
  it("仅缓存受支持且具有非空字符串 ID 的输出项", () => {
    const cache = new ResponsesReferenceCache();
    const items = [
      message("msg_1"),
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "opaque" },
      { id: "fc_1", type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      {
        id: "ws_1",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "天气" },
      },
    ];
    expect(cache.remember("key-a", "model-a", items)).toEqual({ stored: 4, skipped: 0 });
    for (const item of items) expect(cache.resolve("key-a", "model-a", item.id)).toEqual(item);
    const invalid = [
      null,
      "message",
      [],
      123,
      { type: "message" },
      { id: "", type: "message" },
      { id: 1, type: "message" },
      { id: "unsupported", type: "image_generation_call" },
    ];
    expect(cache.remember("key-a", "model-a", invalid)).toEqual({
      stored: 0,
      skipped: invalid.length,
    });
    expect(cache.resolve("key-a", "model-a", "unsupported")).toBeUndefined();
  });

  it("按凭据与模型隔离相同输出 ID", () => {
    const cache = new ResponsesReferenceCache();
    cache.remember("key-a", "model-a", [message("shared", "甲")]);
    expect(cache.resolve("key-b", "model-a", "shared")).toBeUndefined();
    expect(cache.resolve("key-a", "model-b", "shared")).toBeUndefined();
    cache.remember("key-b", "model-a", [message("shared", "乙")]);
    cache.remember("key-a", "model-b", [message("shared", "丙")]);
    expect(cache.resolve("key-a", "model-a", "shared")).toEqual(message("shared", "甲"));
    expect(cache.resolve("key-b", "model-a", "shared")).toEqual(message("shared", "乙"));
    expect(cache.resolve("key-a", "model-b", "shared")).toEqual(message("shared", "丙"));
  });

  it("默认五分钟过期且读取不续期", () => {
    let now = 0;
    const cache = new ResponsesReferenceCache({ now: () => now });
    cache.remember("key", "model", [message("id")]);
    now = 299_999;
    expect(cache.resolve("key", "model", "id")).toEqual(message("id"));
    now = 300_000;
    expect(cache.resolve("key", "model", "id")).toBeUndefined();
  });

  it("主动清理过期项后可复用条目容量", () => {
    let now = 0;
    const cache = new ResponsesReferenceCache({ ttlMs: 100, maxEntries: 2, now: () => now });
    cache.remember("key", "model", [message("old")]);
    now = 50;
    cache.remember("key", "model", [message("live")]);
    now = 100;
    cache.prune();
    expect(cache.resolve("key", "model", "old")).toBeUndefined();
    expect(cache.resolve("key", "model", "live")).toEqual(message("live"));
    cache.remember("key", "model", [message("new")]);
    expect(cache.resolve("key", "model", "live")).toEqual(message("live"));
    expect(cache.resolve("key", "model", "new")).toEqual(message("new"));
  });

  it("相同内容重复写入不延长原始过期时间", () => {
    let now = 0;
    const cache = new ResponsesReferenceCache({ ttlMs: 100, now: () => now });
    cache.remember("key", "model", [message("id")]);
    now = 90;
    cache.remember("key", "model", [message("id")]);
    expect(cache.resolve("key", "model", "id")).toEqual(message("id"));
    now = 100;
    expect(cache.resolve("key", "model", "id")).toBeUndefined();
  });

  it("同一范围内 ID 内容冲突后保持不可读直到原始过期时间", () => {
    let now = 0;
    const cache = new ResponsesReferenceCache({ ttlMs: 100, now: () => now });
    cache.remember("key", "model", [message("id", "原值")]);
    now = 50;
    cache.remember("key", "model", [message("id", "新值")]);
    expect(cache.resolve("key", "model", "id")).toBeUndefined();
    now = 99;
    cache.remember("key", "model", [message("id", "原值")]);
    expect(cache.resolve("key", "model", "id")).toBeUndefined();
    now = 100;
    cache.remember("key", "model", [message("id", "过期后的值")]);
    expect(cache.resolve("key", "model", "id")).toEqual(message("id", "过期后的值"));
  });

  it("全局条目容量按先进先出淘汰，读取和重复写入不改变顺序", () => {
    const cache = new ResponsesReferenceCache({ maxEntries: 2 });
    cache.remember("key-a", "model", [message("first")]);
    cache.remember("key-b", "model", [message("second")]);
    expect(cache.resolve("key-a", "model", "first")).toEqual(message("first"));
    cache.remember("key-a", "model", [message("first")]);
    cache.remember("key-c", "model", [message("third")]);
    expect(cache.resolve("key-a", "model", "first")).toBeUndefined();
    expect(cache.resolve("key-b", "model", "second")).toEqual(message("second"));
    expect(cache.resolve("key-c", "model", "third")).toEqual(message("third"));
  });

  it("凭据条目预算跨模型共享，淘汰不影响其他凭据", () => {
    const cache = new ResponsesReferenceCache({ maxCredentialEntries: 2 });
    cache.remember("other-key", "model", [message("other")]);
    cache.remember("key", "model-a", [message("first")]);
    cache.remember("key", "model-b", [message("second")]);
    cache.remember("key", "model-c", [message("third")]);
    expect(cache.resolve("key", "model-a", "first")).toBeUndefined();
    expect(cache.resolve("key", "model-b", "second")).toEqual(message("second"));
    expect(cache.resolve("key", "model-c", "third")).toEqual(message("third"));
    expect(cache.resolve("other-key", "model", "other")).toEqual(message("other"));
  });

  it("单项超限被跳过且不预先驱逐有效条目", () => {
    const cache = new ResponsesReferenceCache({ maxItemBytes: 1_000, maxEntries: 1 });
    cache.remember("key", "model", [message("kept")]);
    expect(cache.remember("key", "model", [message("huge", "x".repeat(2_000))])).toEqual({
      stored: 0,
      skipped: 1,
    });
    expect(cache.resolve("key", "model", "kept")).toEqual(message("kept"));
    expect(cache.resolve("key", "model", "huge")).toBeUndefined();
  });

  it("单项预算包含固定开销，不只计算 JSON 字符串长度", () => {
    const cache = new ResponsesReferenceCache({ maxItemBytes: 255 });
    expect(cache.remember("key", "model", [{ id: "id", type: "reasoning" }])).toEqual({
      stored: 0,
      skipped: 1,
    });
  });

  it("单项预算按 UTF-8 字节计算多字节文本", () => {
    const cache = new ResponsesReferenceCache({ maxItemBytes: 1_000 });
    expect(cache.remember("key", "model", [message("ascii", "x".repeat(300))])).toEqual({
      stored: 1,
      skipped: 0,
    });
    expect(cache.remember("key", "model", [message("unicode", "中".repeat(300))])).toEqual({
      stored: 0,
      skipped: 1,
    });
    expect(cache.resolve("key", "model", "ascii")).toEqual(message("ascii", "x".repeat(300)));
  });

  it("全局字节预算按先进先出淘汰跨凭据条目", () => {
    const cache = new ResponsesReferenceCache({ maxBytes: 2_200 });
    const text = "x".repeat(500);
    cache.remember("key-a", "model", [message("a", text)]);
    cache.remember("key-b", "model", [message("b", text)]);
    expect(cache.resolve("key-a", "model", "a")).toEqual(message("a", text));
    cache.remember("key-c", "model", [message("c", text)]);
    expect(cache.resolve("key-a", "model", "a")).toBeUndefined();
    expect(cache.resolve("key-b", "model", "b")).toEqual(message("b", text));
    expect(cache.resolve("key-c", "model", "c")).toEqual(message("c", text));
  });

  it("凭据字节预算跨模型共享并保留其他凭据条目", () => {
    const cache = new ResponsesReferenceCache({ maxCredentialBytes: 2_200 });
    const text = "x".repeat(500);
    cache.remember("other-key", "model", [message("other", text)]);
    cache.remember("key", "model-a", [message("a", text)]);
    cache.remember("key", "model-b", [message("b", text)]);
    expect(cache.resolve("key", "model-a", "a")).toEqual(message("a", text));
    cache.remember("key", "model-c", [message("c", text)]);
    expect(cache.resolve("key", "model-a", "a")).toBeUndefined();
    expect(cache.resolve("key", "model-b", "b")).toEqual(message("b", text));
    expect(cache.resolve("key", "model-c", "c")).toEqual(message("c", text));
    expect(cache.resolve("other-key", "model", "other")).toEqual(message("other", text));
  });

  it("无法装入凭据或全局预算的单项不会驱逐有效条目", () => {
    for (const options of [{ maxCredentialBytes: 1_000 }, { maxBytes: 1_000 }]) {
      const cache = new ResponsesReferenceCache(options);
      cache.remember("key", "model", [message("kept")]);
      expect(cache.remember("key", "model", [message("huge", "x".repeat(2_000))])).toEqual({
        stored: 0,
        skipped: 1,
      });
      expect(cache.resolve("key", "model", "kept")).toEqual(message("kept"));
    }
  });

  it("写入和读取均使用 JSON 副本，外部修改不会污染缓存", () => {
    const cache = new ResponsesReferenceCache();
    const original = message("id", "原始内容");
    cache.remember("key", "model", [original]);
    const originalPart = original.content[0];
    if (!originalPart) throw new Error("测试输出应包含文本内容");
    originalPart.text = "写入后修改";
    const resolved = cache.resolve("key", "model", "id");
    expect(resolved).toEqual(message("id", "原始内容"));
    if (!resolved) throw new Error("应能读取已缓存的输出项");
    const parts = resolved.content as Array<{ text: string }>;
    const resolvedPart = parts[0];
    if (!resolvedPart) throw new Error("缓存输出应包含文本内容");
    resolvedPart.text = "读取后修改";
    expect(cache.resolve("key", "model", "id")).toEqual(message("id", "原始内容"));
  });

  it("清空后删除所有凭据的条目及冲突状态并释放容量", () => {
    const cache = new ResponsesReferenceCache({ maxEntries: 2 });
    cache.remember("key-a", "model", [message("a", "原值")]);
    cache.remember("key-a", "model", [message("a", "冲突值")]);
    cache.remember("key-b", "model", [message("b")]);
    cache.clear();
    expect(cache.resolve("key-a", "model", "a")).toBeUndefined();
    expect(cache.resolve("key-b", "model", "b")).toBeUndefined();
    expect(cache.remember("key-a", "model", [message("a", "新值"), message("c")])).toEqual({
      stored: 2,
      skipped: 0,
    });
    expect(cache.resolve("key-a", "model", "a")).toEqual(message("a", "新值"));
    expect(cache.resolve("key-a", "model", "c")).toEqual(message("c"));
  });
});
