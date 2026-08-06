import type { CanonicalRequest } from "../../core/ir.js";
import type { PromptCacheCapability } from "./capabilities.js";
import {
  planPromptCacheBreakpoints,
  type PromptCacheBreakpoint,
  type PromptCacheInput,
} from "./planner.js";
import type { PromptCacheSidecar } from "./sidecar.js";

export interface PromptCacheAttemptInput {
  readonly request: CanonicalRequest;
  readonly sidecar: PromptCacheSidecar;
  readonly enabled: boolean;
  readonly operation: "completion" | "count_tokens";
  readonly capability: PromptCacheCapability;
}

export interface PromptCacheAttempt {
  readonly planned: readonly PromptCacheBreakpoint[];
  readonly encoded: readonly PromptCacheBreakpoint[];
}

export function preparePromptCacheAttempt(input: PromptCacheAttemptInput): PromptCacheAttempt {
  if (
    !input.enabled ||
    input.operation === "count_tokens" ||
    input.capability.kind !== "block-breakpoints"
  ) {
    return { planned: [], encoded: [] };
  }

  const supportedSections = new Set(input.capability.sections);
  const planInput: PromptCacheInput = {
    tools: supportedSections.has("tools") ? input.sidecar.input.tools : [],
    system: supportedSections.has("system") ? input.sidecar.input.system : [],
    messages: supportedSections.has("messages") ? input.sidecar.input.messages : [],
  };
  const planned = planPromptCacheBreakpoints(planInput, {
    enabled: true,
    maxBreakpoints: input.capability.maxBreakpoints,
  });

  return { planned, encoded: [] };
}
