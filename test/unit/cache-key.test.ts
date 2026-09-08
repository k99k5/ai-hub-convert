import { describe, expect, it } from "vitest";
import { withPromptCacheKey } from "../../src/policies/cache/key.js";

const system = { role: "system", content: [{ type: "text", text: "固定提示" }] };
const user = { role: "user", content: [{ type: "text", text: "第一轮" }] };
const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }];

describe("默认提示词缓存键", () => {
  it.each([
    "responses",
    "chat/completions",
  ] as const)("%s 的键不随新增历史、采样或流式选项变化", (path) => {
    const body = { model: "model", input: [system, user], messages: [system, user], tools };
    const key = withPromptCacheKey(path, body).prompt_cache_key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      withPromptCacheKey(path, {
        ...body,
        input: [...body.input, user],
        messages: [...body.messages, user],
        stream: true,
        temperature: 0.2,
      }).prompt_cache_key,
    ).toBe(key);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  it("仅使用开头连续的系统和开发者消息，不把对话中的系统消息移到前缀", () => {
    const body = { model: "model", messages: [system, user] };
    expect(
      withPromptCacheKey("chat/completions", {
        ...body,
        messages: [system, user, { ...system, content: [] }],
      }).prompt_cache_key,
    ).toBe(withPromptCacheKey("chat/completions", body).prompt_cache_key);
    expect(
      withPromptCacheKey("chat/completions", { model: "model", messages: [user, system] }),
    ).not.toHaveProperty("prompt_cache_key");
    expect(
      withPromptCacheKey("chat/completions", {
        model: "model",
        messages: [{ ...system, role: "developer" }],
      }).prompt_cache_key,
    ).toBeTypeOf("string");
  });

  it("模型、协议、工具定义及系统内容变化时生成不同键", () => {
    const body = { model: "model", messages: [system, user], input: [system, user], tools };
    const key = withPromptCacheKey("chat/completions", body).prompt_cache_key;
    for (const changed of [
      { ...body, model: "another" },
      { ...body, tools: [] },
      { ...body, messages: [{ ...system, content: [{ type: "text", text: "新提示" }] }, user] },
    ])
      expect(withPromptCacheKey("chat/completions", changed).prompt_cache_key).not.toBe(key);
    expect(withPromptCacheKey("responses", body).prompt_cache_key).not.toBe(key);
  });

  it.each(["caller-key", "", null])("保留显式键 %s，不自动覆盖", (prompt_cache_key) => {
    const body = { model: "model", messages: [system], prompt_cache_key };
    expect(withPromptCacheKey("chat/completions", body)).toBe(body);
  });

  it("没有稳定前缀时不生成，仅有工具时可以生成", () => {
    expect(withPromptCacheKey("responses", { model: "model", input: [user] })).not.toHaveProperty(
      "prompt_cache_key",
    );
    expect(withPromptCacheKey("responses", { model: "model", tools }).prompt_cache_key).toBeTypeOf(
      "string",
    );
  });
});
