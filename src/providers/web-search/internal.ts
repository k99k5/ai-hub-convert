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
