export type PromptCacheNodeId = `tool:${number}` | `system:${number}` | `message:${number}`;

export interface PromptCacheNode {
  readonly id: PromptCacheNodeId;
  readonly explicitBreakpoint?: boolean;
}

export interface PromptCacheInput {
  readonly tools: readonly PromptCacheNode[];
  readonly system: readonly PromptCacheNode[];
  readonly messages: readonly PromptCacheNode[];
}

export interface PromptCachePlanOptions {
  enabled: boolean;
  maxBreakpoints?: number;
}

export type PromptCacheSection = "tools" | "system" | "messages";

export interface PromptCacheBreakpoint {
  nodeId: PromptCacheNodeId;
  source: "explicit" | "automatic";
  section: PromptCacheSection;
  reason: string;
}

interface Candidate extends PromptCacheBreakpoint {}

const DEFAULT_MAX_BREAKPOINTS = 4;

export function planPromptCacheBreakpoints(
  input: PromptCacheInput,
  options: PromptCachePlanOptions,
): PromptCacheBreakpoint[] {
  const requestedLimit = options.maxBreakpoints ?? DEFAULT_MAX_BREAKPOINTS;
  const finiteLimit = Number.isFinite(requestedLimit) ? requestedLimit : DEFAULT_MAX_BREAKPOINTS;
  const maxBreakpoints = Math.min(DEFAULT_MAX_BREAKPOINTS, Math.max(0, Math.floor(finiteLimit)));
  if (maxBreakpoints === 0) {
    return [];
  }

  const explicit = collectExplicit(input);
  if (!options.enabled) {
    return takeUnique(explicit, maxBreakpoints);
  }

  return takeUnique([...explicit, ...collectAutomatic(input)], maxBreakpoints);
}

function collectExplicit(input: PromptCacheInput): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [section, nodes] of sections(input)) {
    for (const node of nodes) {
      if (node.explicitBreakpoint) {
        candidates.push({
          nodeId: node.id,
          source: "explicit",
          section,
          reason: "explicit breakpoint",
        });
      }
    }
  }
  return candidates;
}

function collectAutomatic(input: PromptCacheInput): Candidate[] {
  const candidates: Candidate[] = [];
  const tool = input.tools.at(-1);
  if (tool) {
    candidates.push({
      nodeId: tool.id,
      source: "automatic",
      section: "tools",
      reason: "last tool",
    });
  }

  const system = input.system.at(-1);
  if (system) {
    candidates.push({
      nodeId: system.id,
      source: "automatic",
      section: "system",
      reason: "last system block",
    });
  }

  const historicalMessage = input.messages.at(-2);
  if (historicalMessage) {
    candidates.push({
      nodeId: historicalMessage.id,
      source: "automatic",
      section: "messages",
      reason: "historical message boundary",
    });
  }

  return candidates;
}

function sections(
  input: PromptCacheInput,
): readonly (readonly [PromptCacheSection, readonly PromptCacheNode[]])[] {
  return [
    ["tools", input.tools],
    ["system", input.system],
    ["messages", input.messages],
  ];
}

function takeUnique(candidates: readonly Candidate[], limit: number): PromptCacheBreakpoint[] {
  const result: PromptCacheBreakpoint[] = [];
  const seen = new Set<PromptCacheNodeId>();
  for (const candidate of candidates) {
    if (result.length >= limit) {
      break;
    }
    if (!seen.has(candidate.nodeId)) {
      seen.add(candidate.nodeId);
      result.push({ ...candidate });
    }
  }
  return result;
}
