import type { Usage } from "../core/ir.js";

export type CompletionPath = "responses" | "chat/completions";

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid upstream usage object");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid upstream token usage");
  }
  return value;
}

export function readCompletionUsage(path: CompletionPath, response: unknown): Usage {
  const usage = record(record(response).usage);
  const input = record(
    path === "responses" ? usage.input_tokens_details : usage.prompt_tokens_details,
  );
  const output = record(
    path === "responses" ? usage.output_tokens_details : usage.completion_tokens_details,
  );
  const cached = count(input.cached_tokens);
  const written = count(input.cache_write_tokens);
  const reasoning = count(output.reasoning_tokens);
  return {
    inputTokens: count(path === "responses" ? usage.input_tokens : usage.prompt_tokens) ?? 0,
    outputTokens: count(path === "responses" ? usage.output_tokens : usage.completion_tokens) ?? 0,
    ...(cached === undefined ? {} : { cacheReadInputTokens: cached }),
    ...(written === undefined ? {} : { cacheWriteInputTokens: written }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

export function sumUsage(total: Usage, usage: Usage): Usage {
  const next = { ...total };
  for (const key of Object.keys(usage) as Array<keyof Usage>) {
    const value = usage[key];
    if (value !== undefined) {
      const sum = (total[key] ?? 0) + value;
      if (!Number.isSafeInteger(sum) || sum < 0) throw new Error("Invalid aggregate token usage");
      next[key] = sum;
    }
  }
  return next;
}

export function replaceCompletionUsage(
  path: CompletionPath,
  response: unknown,
  total: Usage,
): unknown {
  const body = record(response);
  const usage = record(body.usage);
  const inputKey = path === "responses" ? "input_tokens_details" : "prompt_tokens_details";
  const outputKey = path === "responses" ? "output_tokens_details" : "completion_tokens_details";
  return {
    ...body,
    usage: {
      ...usage,
      [path === "responses" ? "input_tokens" : "prompt_tokens"]: total.inputTokens,
      [path === "responses" ? "output_tokens" : "completion_tokens"]: total.outputTokens,
      total_tokens: total.inputTokens + total.outputTokens,
      ...(total.cacheReadInputTokens === undefined && total.cacheWriteInputTokens === undefined
        ? {}
        : {
            [inputKey]: {
              ...record(usage[inputKey]),
              ...(total.cacheReadInputTokens === undefined
                ? {}
                : { cached_tokens: total.cacheReadInputTokens }),
              ...(total.cacheWriteInputTokens === undefined
                ? {}
                : { cache_write_tokens: total.cacheWriteInputTokens }),
            },
          }),
      ...(total.reasoningTokens === undefined
        ? {}
        : {
            [outputKey]: { ...record(usage[outputKey]), reasoning_tokens: total.reasoningTokens },
          }),
    },
  };
}
