import { createHash } from "node:crypto";
import type { ResponsesToolBinding } from "../../core/ir.js";
import { INTERNAL_WEB_SEARCH_TOOL_NAME } from "../../providers/web-search/internal.js";
import { normalizeResponsesTool } from "./input-normalize.js";
import type { ResponsesSseFrame } from "./stream-encode.js";
import { OpenAIAdapterError } from "./types.js";

type Wire = Record<string, unknown>;

function invalid(message: string): never {
  throw new OpenAIAdapterError("INVALID_OPENAI_RESPONSES_REQUEST", message);
}

function record(value: unknown): value is Wire {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function name(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${label} must be a non-empty string`);
  return value;
}

function namespace(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = name(value, "tool namespace");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(result)) invalid("Invalid tool namespace");
  return result;
}

function identity(type: string, toolName: string, group?: string): string {
  return JSON.stringify([type, group ?? null, toolName]);
}

function isUnnamespacedWebSearch(value: Wire): boolean {
  return value.name === "web_search" && (value.namespace === undefined || value.namespace === null);
}

function customDescription(tool: Wire): string {
  if (tool.description !== undefined && typeof tool.description !== "string") {
    invalid("custom tool description must be a string");
  }
  let description = `${tool.description ?? ""}\nPass the complete raw tool input as the string field "input". Do not JSON-encode the string itself.`;
  if (tool.format !== undefined) {
    const format = tool.format;
    if (!record(format) || (format.type !== "text" && format.type !== "grammar")) {
      invalid("custom tool format must be text or grammar");
    }
    if (format.type === "grammar") {
      if (format.syntax !== "lark" && format.syntax !== "regex") {
        invalid("custom tool grammar syntax must be lark or regex");
      }
      const definition = name(format.definition, "custom tool grammar definition");
      description += `\nThe raw input must follow this ${format.syntax} grammar:\n${definition}`;
    }
  }
  return description.trim();
}

// Both upstream protocols receive ordinary functions. Identity hashes stay stable
// across tool order, continuations and requests, and fit Chat's 64-character limit.
export function normalizeResponsesTools(body: Wire): {
  wire: Wire;
  bindings: ResponsesToolBinding[];
} {
  const bindings = new Map<string, ResponsesToolBinding>();
  const names = new Map<string, string>();
  const definitions = new Map<string, Wire>();
  const bind = (type: ResponsesToolBinding["type"], toolName: string, group?: string): string => {
    if ((type === "custom" || group !== undefined) && !/^[a-zA-Z0-9_-]{1,64}$/.test(toolName)) {
      invalid(
        "Custom and namespaced tool names must contain 1-64 letters, digits, underscores or hyphens",
      );
    }
    const key = identity(type, toolName, group);
    const upstreamName =
      type === "function" && group === undefined
        ? toolName
        : `codex_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const existing = names.get(upstreamName);
    if (existing !== undefined && existing !== key) invalid("Conflicting Responses tool names");
    names.set(upstreamName, key);
    if (upstreamName !== toolName || type === "custom") {
      bindings.set(upstreamName, {
        upstreamName,
        type,
        name: toolName,
        ...(group === undefined ? {} : { namespace: group }),
      });
    }
    return upstreamName;
  };
  const add = (raw: unknown, group?: string, groupDescription?: string): Wire[] => {
    if (!record(raw)) invalid("Invalid OpenAI Responses request: tool must be an object");
    if (raw.type === "namespace") {
      if (group !== undefined) invalid("Nested tool namespaces are not supported");
      const groupName = namespace(raw.name);
      if (groupName === undefined || !Array.isArray(raw.tools))
        invalid("namespace tools must be an array with a namespace name");
      if (raw.description !== undefined && typeof raw.description !== "string")
        invalid("namespace description must be a string");
      return raw.tools.flatMap((tool) =>
        add(tool, groupName, raw.description as string | undefined),
      );
    }
    if (raw.type === "tool_search" && group === undefined) {
      if (raw.execution !== "client") invalid("tool_search only supports execution: client");
      if (!record(raw.parameters)) invalid("client tool_search parameters must be an object");
      if (raw.description != null && typeof raw.description !== "string")
        invalid("tool_search description must be a string or null");
      const tool: Wire = {
        type: "function",
        name: bind("tool_search", "tool_search"),
        parameters: raw.parameters,
        ...(raw.description == null ? {} : { description: raw.description }),
      };
      definitions.set(identity("tool_search", "tool_search"), tool);
      return [tool];
    }
    if (raw.type === "custom" && group === undefined && isUnnamespacedWebSearch(raw)) {
      // 兼容客户端搜索别名；保留原工具身份，使续轮声明仍按顺序覆盖。
      customDescription(raw);
      const tool: Wire = {
        type: "web_search",
        ...(raw.external_web_access === undefined
          ? {}
          : { external_web_access: raw.external_web_access }),
      };
      definitions.set(identity("custom", "web_search"), tool);
      return [tool];
    }
    if (raw.type !== "function" && raw.type !== "custom") {
      if (group !== undefined)
        invalid(`Unsupported OpenAI Responses namespace tool type: ${String(raw.type)}`);
      definitions.set(`builtin:${String(raw.type)}:${definitions.size}`, raw);
      return [raw];
    }
    const toolName = name(raw.name, "tool name");
    const upstreamName = bind(raw.type, toolName, group);
    let tool: Wire;
    if (raw.type === "custom") {
      tool = {
        type: "function",
        name: upstreamName,
        description: customDescription(raw),
        strict: true,
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
      };
    } else {
      tool = { ...raw, name: upstreamName };
      if (group !== undefined && tool.description === null) delete tool.description;
    }
    if (group !== undefined) {
      if (tool.description !== undefined && typeof tool.description !== "string")
        invalid("tool description must be a string");
      tool.description = [`Tool ${group}.${toolName}.`, groupDescription, tool.description]
        .filter(Boolean)
        .join("\n");
    }
    // additional_tools adds declarations in input order; later versions replace
    // an earlier declaration of the same tool without introducing duplicates.
    definitions.set(identity(raw.type, toolName, group), tool);
    return [tool];
  };
  if (body.tools != null) {
    if (!Array.isArray(body.tools))
      invalid("Invalid OpenAI Responses request: tools must be an array");
    for (const tool of body.tools) add(tool);
  }
  const input = Array.isArray(body.input)
    ? body.input.flatMap((item: unknown) => {
        if (!record(item)) return [item];
        if (item.type === "additional_tools") {
          if (item.role !== "developer" || !Array.isArray(item.tools))
            invalid("additional_tools requires role developer and a tools array");
          for (const tool of item.tools) add(tool);
          return [];
        }
        if (item.type === "tool_search_call" || item.type === "tool_search_output") {
          if (item.execution !== undefined && item.execution !== "client")
            invalid(`${item.type} only supports execution: client`);
          const callId = name(item.call_id, `${item.type} call_id`);
          const fields = { id: item.id, status: item.status, call_id: callId };
          if (item.type === "tool_search_call") {
            if (!record(item.arguments)) invalid("tool_search_call.arguments must be an object");
            return [
              {
                ...fields,
                type: "function_call",
                name: bind("tool_search", "tool_search"),
                arguments: JSON.stringify(item.arguments),
              },
            ];
          }
          if (!Array.isArray(item.tools)) invalid("tool_search_output.tools must be an array");
          const tools = item.tools.flatMap((tool) => add(tool)).map(normalizeResponsesTool);
          return [{ ...fields, type: "function_call_output", output: JSON.stringify({ tools }) }];
        }
        if (item.type === "custom_tool_call_output")
          return [{ ...item, type: "function_call_output" }];
        if (item.type !== "function_call" && item.type !== "custom_tool_call") return [item];
        const group = namespace(item.namespace);
        const toolName = name(item.name, "tool call name");
        const custom = item.type === "custom_tool_call";
        if (custom && typeof item.input !== "string")
          invalid("custom_tool_call.input must be a string");
        if (custom && group === undefined && isUnnamespacedWebSearch(item)) {
          return [
            {
              ...item,
              type: "function_call",
              name: INTERNAL_WEB_SEARCH_TOOL_NAME,
              arguments: JSON.stringify({ query: item.input }),
            },
          ];
        }
        const { namespace: _namespace, input: _input, ...call } = item;
        return [
          {
            ...call,
            type: "function_call",
            name: bind(custom ? "custom" : "function", toolName, group),
            ...(custom ? { arguments: JSON.stringify({ input: item.input }) } : {}),
          },
        ];
      })
    : body.input;
  const choice = (value: unknown): unknown => {
    if (!record(value)) return value;
    if (value.type === "allowed_tools" && Array.isArray(value.tools))
      return { ...value, tools: value.tools.map(choice) };
    if (value.type === "tool_search")
      return { type: "function", name: bind("tool_search", "tool_search") };
    if (value.type === "custom" && isUnnamespacedWebSearch(value)) return { type: "web_search" };
    if (value.type !== "function" && value.type !== "custom") return value;
    const toolName = name(value.name, "tool_choice name");
    const group = namespace(value.namespace);
    return { type: "function", name: bind(value.type, toolName, group) };
  };
  const wire = {
    ...body,
    input,
    tools: [...definitions.values()],
    ...(body.tool_choice === undefined ? {} : { tool_choice: choice(body.tool_choice) }),
  };
  return { wire, bindings: [...bindings.values()] };
}

function customInput(value: unknown): string {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    /* Report a protocol error below. */
  }
  if (
    !record(parsed) ||
    typeof parsed.input !== "string" ||
    Object.keys(parsed).some((key) => key !== "input")
  ) {
    throw new OpenAIAdapterError(
      "INVALID_OPENAI_RESPONSES_RESPONSE",
      "Upstream custom tool arguments must contain exactly one string field: input",
    );
  }
  return parsed.input;
}

function searchArguments(value: unknown): Wire {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    /* Report a protocol error below. */
  }
  if (!record(parsed)) {
    throw new OpenAIAdapterError(
      "INVALID_OPENAI_RESPONSES_RESPONSE",
      "Upstream tool_search arguments must be a JSON object",
    );
  }
  return parsed;
}

// Restore before sending or remembering outputs, so caches and client history
// contain native Responses items rather than internal aliases/JSON wrappers.
export class ResponsesToolOutput {
  readonly #bindings: Map<string, ResponsesToolBinding>;
  readonly #items = new Map<unknown, ResponsesToolBinding>();
  #sequence = 0;

  constructor(bindings: readonly ResponsesToolBinding[] = []) {
    this.#bindings = new Map(bindings.map((binding) => [binding.upstreamName, binding]));
  }

  #item(value: unknown, added = false): unknown {
    if (!record(value) || value.type !== "function_call") return value;
    const binding = this.#bindings.get(value.name as string);
    if (!binding) return value;
    if (binding.type === "tool_search") {
      return {
        type: "tool_search_call",
        id: value.id,
        call_id: value.call_id,
        status: value.status,
        execution: "client",
        arguments: added ? {} : searchArguments(value.arguments),
      };
    }
    const { arguments: args, ...item } = value;
    const fields = {
      ...item,
      name: binding.name,
      ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
    };
    return binding.type === "custom"
      ? { ...fields, type: "custom_tool_call", input: added ? "" : customInput(args) }
      : { ...fields, arguments: args };
  }

  response(response: Wire): Wire {
    if (this.#bindings.size === 0 || !Array.isArray(response.output)) return response;
    return { ...response, output: response.output.map((item) => this.#item(item)) };
  }

  frames(frame: ResponsesSseFrame): ResponsesSseFrame[] {
    if (this.#bindings.size === 0) return [frame];
    let data = frame.data;
    let frames: ResponsesSseFrame[];
    if (frame.event === "response.output_item.added" && record(data.item)) {
      const binding = this.#bindings.get(data.item.name as string);
      if (data.item.type === "function_call" && binding)
        this.#items.set(data.output_index, binding);
      data = { ...data, item: this.#item(data.item, true) };
    } else if (frame.event === "response.output_item.done") {
      data = { ...data, item: this.#item(data.item) };
      this.#items.delete(data.output_index);
    }
    const binding = this.#items.get(data.output_index);
    // Native search calls carry an arguments object on output_item.done; there
    // are no function argument delta/done events for the client to execute.
    if (
      binding?.type === "tool_search" &&
      (frame.event === "response.function_call_arguments.delta" ||
        frame.event === "response.function_call_arguments.done")
    )
      return [];
    if (binding?.type === "custom" && frame.event === "response.function_call_arguments.delta")
      return [];
    if (binding?.type === "custom" && frame.event === "response.function_call_arguments.done") {
      const input = customInput(data.arguments);
      const fields = { item_id: data.item_id, output_index: data.output_index };
      frames = [
        { event: "response.custom_tool_call_input.delta", data: { ...fields, delta: input } },
        { event: "response.custom_tool_call_input.done", data: { ...fields, input } },
      ];
    } else {
      if (binding && frame.event === "response.function_call_arguments.done")
        data = {
          ...data,
          name: binding.name,
          ...(binding.namespace === undefined ? {} : { namespace: binding.namespace }),
        };
      if (record(data.response)) data = { ...data, response: this.response(data.response) };
      frames = [{ event: frame.event, data }];
    }
    return frames.map((item) => ({
      event: item.event,
      data: { ...item.data, type: item.event, sequence_number: this.#sequence++ },
    }));
  }
}
