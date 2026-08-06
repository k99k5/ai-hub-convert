import { randomUUID } from "node:crypto";

export interface ThinkingBlock {
  readonly text: string;
  readonly signature?: string;
  readonly synthetic?: boolean;
}

export type FinalizedThinkingBlock =
  | {
      readonly text: string;
      readonly signature: string;
      readonly synthetic: boolean;
    }
  | {
      readonly text: string;
    };

export interface FinalizeThinkingBlockOptions {
  enabled: boolean;
  uuidFactory?: () => string;
}

export function createSyntheticThinkingSignature(uuidFactory: () => string = randomUUID): string {
  return Buffer.from(uuidFactory(), "utf8").toString("base64");
}

export function finalizeThinkingBlock(
  block: ThinkingBlock,
  options: FinalizeThinkingBlockOptions,
): FinalizedThinkingBlock {
  if (block.signature) {
    return Object.freeze({ text: block.text, signature: block.signature, synthetic: false });
  }
  if (!options.enabled) {
    return Object.freeze({ text: block.text });
  }

  return Object.freeze({
    text: block.text,
    signature: createSyntheticThinkingSignature(options.uuidFactory),
    synthetic: true,
  });
}
