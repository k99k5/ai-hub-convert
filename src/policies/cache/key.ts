import { createHash } from "node:crypto";

interface PromptCacheBody {
  model: string;
  tools?: readonly unknown[];
  input?: readonly unknown[];
  messages?: readonly unknown[];
  prompt_cache_key?: string | null;
}

/** 只使用实际编码后的静态前缀分组；对话追加和流式选项不改变缓存键。 */
export function withPromptCacheKey<T extends PromptCacheBody>(
  path: "responses" | "chat/completions",
  body: T,
): T & { prompt_cache_key?: string | null } {
  if (body.prompt_cache_key !== undefined) return body;
  const tools = body.tools ?? [];
  const prefix: unknown[] = [];
  for (const message of (path === "responses" ? body.input : body.messages) ?? []) {
    if (typeof message !== "object" || message === null || !("role" in message)) break;
    if (message.role !== "system" && message.role !== "developer") break;
    prefix.push(message);
  }
  if (tools.length === 0 && prefix.length === 0) return body;
  const key = createHash("sha256")
    .update(JSON.stringify({ version: 1, path, model: body.model, tools, prefix }))
    .digest("hex");
  return { ...body, prompt_cache_key: key };
}
