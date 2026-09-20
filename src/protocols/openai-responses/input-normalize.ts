// Called after decoding: retain only understood wire fields in continuation
// history, without recursively filtering user text or serialized tool arguments.
type Wire = Record<string, unknown>;

function pick(value: Wire, fields: readonly string[]): Wire {
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)));
}

function content(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((part: Wire) => {
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "summary_text":
        return pick(part, ["type", "text"]);
      case "input_image":
        return pick(part, ["type", "image_url", "detail"]);
      case "refusal":
        return pick(part, ["type", "refusal"]);
      default:
        return part;
    }
  });
}

function tool(raw: Wire): Wire {
  if (raw.type === "namespace")
    return {
      ...pick(raw, ["type", "name", "description"]),
      tools: (raw.tools as Wire[]).map(tool),
    };
  if (raw.type === "function")
    return pick(raw, ["type", "name", "description", "parameters", "strict"]);
  if (raw.type === "custom")
    return {
      ...pick(raw, ["type", "name", "description"]),
      ...(raw.format === undefined
        ? {}
        : { format: pick(raw.format as Wire, ["type", "syntax", "definition"]) }),
    };
  return {
    ...pick(raw, ["type", "search_context_size", "external_web_access", "search_content_types"]),
    ...(raw.filters == null
      ? {}
      : { filters: pick(raw.filters as Wire, ["allowed_domains", "blocked_domains"]) }),
    ...(raw.user_location == null
      ? {}
      : {
          user_location: pick(raw.user_location as Wire, [
            "type",
            "city",
            "country",
            "region",
            "timezone",
          ]),
        }),
  };
}

export function normalizeResponsesInput(input: readonly unknown[]): unknown[] {
  return input.map((raw) => {
    const item = raw as Wire;
    switch (item.type) {
      case undefined:
      case "message":
        return { ...pick(item, ["type", "id", "status", "role"]), content: content(item.content) };
      case "item_reference":
        return pick(item, ["type", "id"]);
      case "reasoning":
        return {
          ...pick(item, ["type", "id", "status", "encrypted_content"]),
          summary: content(item.summary),
        };
      case "function_call":
        return pick(item, ["type", "id", "status", "call_id", "name", "namespace", "arguments"]);
      case "custom_tool_call":
        return pick(item, ["type", "id", "status", "call_id", "name", "namespace", "input"]);
      case "additional_tools":
        return { ...pick(item, ["type", "id", "role"]), tools: (item.tools as Wire[]).map(tool) };
      case "custom_tool_call_output":
      case "function_call_output":
        return {
          ...pick(item, ["type", "id", "status", "call_id"]),
          output: content(item.output),
        };
      case "web_search_call": {
        const rawAction = item.action as Wire;
        const action = pick(
          rawAction,
          rawAction.type === "search"
            ? ["type", "query", "queries", "sources"]
            : rawAction.type === "open_page"
              ? ["type", "url"]
              : ["type", "url", "pattern"],
        );
        if (rawAction.type === "search" && Array.isArray(action.sources)) {
          action.sources = action.sources.map((source: Wire) => pick(source, ["type", "url"]));
        }
        return { ...pick(item, ["type", "id", "status"]), action };
      }
      default:
        return item;
    }
  });
}
