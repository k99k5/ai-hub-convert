import { createHash } from "node:crypto";

export const INTERNAL_WEB_SEARCH_TOOL_NAME = "__ai_hub_web_search";

export const INTERNAL_WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the web. This tool is executed by the protocol gateway.";

export const INTERNAL_WEB_SEARCH_TOOL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string" },
  },
  required: ["query"],
  additionalProperties: false,
};

export function isInternalWebSearchToolName(name: unknown): name is string {
  return name === INTERNAL_WEB_SEARCH_TOOL_NAME;
}

export function createWebSearchReplayToken(
  searchIndex: number,
  resultIndex: number,
  query: string,
  result: { title: string; url: string },
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([searchIndex, resultIndex, query, result.title, result.url]), "utf8")
    .digest("base64url");
  return `ai_hub_replay_v1:${digest}`;
}
