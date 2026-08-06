import type { PromptCacheSection } from "./planner.js";

export type PromptCacheCapability =
  | { readonly kind: "none" }
  | { readonly kind: "prompt-cache-key" }
  | {
      readonly kind: "block-breakpoints";
      readonly sections: readonly PromptCacheSection[];
      readonly maxBreakpoints: number;
    };

export interface PromptCacheCapabilities {
  readonly responses: PromptCacheCapability;
  readonly chatCompletions: PromptCacheCapability;
}

export const GENERIC_PROMPT_CACHE_CAPABILITIES: PromptCacheCapabilities = {
  responses: { kind: "none" },
  chatCompletions: { kind: "none" },
};
