import type { PromptCacheInput, PromptCacheNodeId } from "./planner.js";

export interface PromptCacheMarker {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}

export interface PromptCacheExplicitMarker {
  readonly nodeId: PromptCacheNodeId;
  readonly marker: PromptCacheMarker;
}

export interface PromptCacheSidecar {
  readonly input: PromptCacheInput;
  readonly explicitMarkers: readonly PromptCacheExplicitMarker[];
}

interface PromptCacheNodeCounts {
  toolCount: number;
  systemCount: number;
  messageCount: number;
}

export function createPromptCacheInput(
  counts: PromptCacheNodeCounts,
  explicitMarkers: readonly PromptCacheExplicitMarker[],
): PromptCacheInput {
  const explicit = new Set(explicitMarkers.map(({ nodeId }) => nodeId));
  return {
    tools: Array.from({ length: counts.toolCount }, (_, index) =>
      createNode(`tool:${index}`, explicit),
    ),
    system: Array.from({ length: counts.systemCount }, (_, index) =>
      createNode(`system:${index}`, explicit),
    ),
    messages: Array.from({ length: counts.messageCount }, (_, index) =>
      createNode(`message:${index}`, explicit),
    ),
  };
}

function createNode(id: PromptCacheNodeId, explicit: ReadonlySet<PromptCacheNodeId>) {
  return {
    id,
    ...(explicit.has(id) ? { explicitBreakpoint: true } : {}),
  };
}
