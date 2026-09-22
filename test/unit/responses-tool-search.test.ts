import { describe, expect, it } from "vitest";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { normalizeResponsesInput } from "../../src/protocols/openai-responses/input-normalize.js";
import { ResponsesToolOutput } from "../../src/protocols/openai-responses/tool-compat.js";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";

const search = {
  type: "tool_search",
  execution: "client",
  description: "Find tools by query",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
    additionalProperties: false,
  },
};
const fn = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
const call = {
  type: "tool_search_call",
  id: "search_1",
  call_id: "call_search",
  execution: "client",
  status: "completed",
  arguments: { query: "lookup", limit: 1 },
};
const result = {
  type: "tool_search_output",
  call_id: "call_search",
  execution: "client",
  tools: [fn],
};

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a tool or output");
  return value;
}

describe("client tool_search compatibility", () => {
  it.each([
    { type: "tool_search" },
    { type: "allowed_tools", mode: "required", tools: [{ type: "tool_search" }] },
  ])("maps search declarations and choices to a distinct portable function: %j", (tool_choice) => {
    const request = decodeResponsesRequest({
      model: "m",
      tools: [search, { ...fn, name: "tool_search" }],
      tool_choice,
    });
    const binding = present(request.responsesToolBindings?.[0]);
    expect(binding).toMatchObject({ type: "tool_search", name: "tool_search" });
    expect(binding.upstreamName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(binding.upstreamName).not.toBe("tool_search");
    expect(request.tools[0]).toEqual({
      type: "function",
      name: binding.upstreamName,
      description: search.description,
      inputSchema: search.parameters,
    });
    if (tool_choice.type === "tool_search") {
      expect(request.toolChoice).toEqual({ type: "function", name: binding.upstreamName });
      expect(request.tools).toHaveLength(2);
    } else {
      expect(request.toolChoice).toEqual({ type: "required" });
      expect(request.tools).toHaveLength(1);
    }
  });

  it("restores native search calls and replays them without a current search declaration", () => {
    const request = decodeResponsesRequest({ model: "m", tools: [search] });
    const binding = present(request.responsesToolBindings?.[0]);
    const output = new ResponsesToolOutput(request.responsesToolBindings);
    const response = output.response({
      output: [
        {
          type: "function_call",
          id: call.id,
          call_id: call.call_id,
          status: "completed",
          name: binding.upstreamName,
          arguments: JSON.stringify(call.arguments),
        },
      ],
    });
    expect(response.output).toEqual([call]);
    const replay = decodeResponsesRequest({ model: "m", input: [call, result] });
    expect(replay.responsesToolBindings).toEqual(request.responsesToolBindings);
    expect(replay.messages[0]?.content).toMatchObject([
      {
        type: "function_call",
        id: call.call_id,
        name: binding.upstreamName,
        arguments: JSON.stringify(call.arguments),
      },
    ]);
    expect(replay.tools).toMatchObject([{ name: "lookup" }]);
  });

  it("loads function/custom namespaces, uses stable aliases, and replaces declarations in input order", () => {
    const custom = { type: "custom", name: "exec", format: { type: "text" } };
    const loaded = {
      type: "namespace",
      name: "functions",
      tools: [fn, custom],
    };
    const request = decodeResponsesRequest({
      model: "m",
      tools: [search],
      input: [
        call,
        { ...result, tools: [loaded] },
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              ...loaded,
              tools: [{ ...fn, description: "Updated lookup" }],
            },
          ],
        },
      ],
    });
    expect(request.tools).toHaveLength(3);
    const loadedBindings = present(request.responsesToolBindings).filter((b) => b.namespace);
    const toolResult = present(request.messages[1]?.content[0]);
    expect(toolResult.type).toBe("function_result");
    if (toolResult.type !== "function_result") throw new Error("Expected a function result");
    const portable = JSON.parse(toolResult.output).tools;
    expect(portable.map((tool: { name: string }) => tool.name)).toEqual(
      loadedBindings.map((binding) => binding.upstreamName),
    );
    expect(portable.every((tool: { type: string }) => tool.type === "function")).toBe(true);
    expect(request.tools[1]).toHaveProperty(
      "description",
      "Tool functions.lookup.\nUpdated lookup",
    );
    const customBinding = present(loadedBindings.find((binding) => binding.type === "custom"));
    expect(
      new ResponsesToolOutput(request.responsesToolBindings).response({
        output: [
          { type: "function_call", name: customBinding.upstreamName, arguments: '{"input":"raw"}' },
        ],
      }).output,
    ).toMatchObject([
      { type: "custom_tool_call", namespace: "functions", name: "exec", input: "raw" },
    ]);
  });

  it("accepts empty discovery results and omitted execution on client history items", () => {
    const request = decodeResponsesRequest({
      model: "m",
      input: [
        { ...call, execution: undefined },
        { ...result, execution: undefined, tools: [] },
      ],
    });
    expect(request.tools).toEqual([]);
    expect(request.messages[1]?.content).toMatchObject([
      {
        type: "function_result",
        callId: call.call_id,
        output: '{"tools":[]}',
      },
    ]);
  });

  it("keeps native history and application JSON while stripping unknown wire fields", () => {
    const parameters = { type: "object", properties: { client_extra: { type: "string" } } };
    const input = [
      { type: "additional_tools", role: "developer", tools: [{ ...search, client_extra: "drop" }] },
      { ...call, arguments: { client_extra: "keep" }, client_extra: "drop" },
      {
        ...result,
        client_extra: "drop",
        tools: [{ ...fn, parameters, defer_loading: true, client_extra: "drop" }],
      },
    ];
    const request = decodeResponsesRequest({ model: "m", input });
    const normalized = normalizeResponsesInput(input);
    expect(normalized[1]).toHaveProperty("arguments", { client_extra: "keep" });
    expect(normalized[2]).toHaveProperty("tools", [{ ...fn, parameters }]);
    expect(JSON.stringify(normalized)).not.toContain('"drop"');
    expect(JSON.stringify(request)).not.toContain('"drop"');
    expect(decodeResponsesRequest({ model: "m", input: normalized })).toEqual(request);
  });

  it("emits native search items without function argument events and preserves interleaved calls", () => {
    const request = decodeResponsesRequest({ model: "m", tools: [search, fn] });
    const binding = present(request.responsesToolBindings?.[0]);
    const output = new ResponsesToolOutput(request.responsesToolBindings);
    const encoder = new ResponsesStreamEncoder();
    const frames: ReturnType<typeof encoder.encode> = [];
    const emit = (event: Parameters<typeof encoder.encode>[0]) =>
      frames.push(...encoder.encode(event).flatMap((frame) => output.frames(frame)));
    emit({ type: "response_start", id: "r", model: "m" });
    emit({
      type: "content_start",
      index: 0,
      itemId: "search_1",
      content: {
        type: "function_call",
        id: call.call_id,
        name: binding.upstreamName,
        arguments: "",
      },
    });
    emit({
      type: "content_start",
      index: 1,
      itemId: "fn_1",
      content: {
        type: "function_call",
        id: "call_fn",
        name: "lookup",
        arguments: "",
      },
    });
    emit({ type: "function_arguments_delta", index: 1, delta: "{}" });
    for (const delta of JSON.stringify(call.arguments))
      emit({ type: "function_arguments_delta", index: 0, delta });
    emit({ type: "content_stop", index: 0 });
    emit({ type: "content_stop", index: 1 });
    emit({
      type: "response_complete",
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(frames.map((frame) => frame.data.sequence_number)).toEqual(frames.map((_, i) => i));
    expect(
      frames
        .filter((frame) => frame.event.startsWith("response.function_call_arguments"))
        .map((frame) => frame.data.output_index),
    ).toEqual([1, 1]);
    expect(
      frames.find((frame) => frame.event === "response.output_item.added")?.data.item,
    ).toMatchObject({
      type: "tool_search_call",
      execution: "client",
      arguments: {},
      status: "in_progress",
    });
    expect(frames.find((frame) => frame.event === "response.output_item.done")?.data.item).toEqual(
      call,
    );
    expect(frames.at(-1)?.data.response).toMatchObject({
      output: [call, { type: "function_call", name: "lookup" }],
    });
  });

  it.each([
    { tools: [{ ...search, execution: "server" }] },
    { tools: [{ ...search, execution: undefined }] },
    { tools: [{ ...search, parameters: null }] },
    { tools: [{ ...search, parameters: [] }] },
    { tools: [{ ...search, description: 3 }] },
    { tools: [{ type: "namespace", name: "bad", tools: [search] }] },
    { input: [{ ...call, execution: "server" }] },
    { input: [{ ...call, call_id: null }] },
    { input: [{ ...call, arguments: "{}" }] },
    { input: [{ ...call, arguments: [] }] },
    { input: [{ ...call, arguments: null }] },
    { input: [{ ...result, execution: "server" }] },
    { input: [{ ...result, call_id: "" }] },
    { input: [{ ...result, tools: null }] },
    { input: [{ ...result, tools: [{ type: "mcp" }] }] },
    { input: [{ ...result, tools: [{ ...fn, parameters: [] }] }] },
    { tool_choice: { type: "tool_search" } },
  ])("rejects unsupported or malformed client search before forwarding: %j", (body) => {
    expect(() => decodeResponsesRequest({ model: "m", ...body })).toThrow();
  });

  it.each([
    '{"query":',
    '"query"',
    "null",
    "[]",
  ])("rejects non-object search arguments: %s", (argumentsJson) => {
    const request = decodeResponsesRequest({ model: "m", tools: [search] });
    expect(() =>
      new ResponsesToolOutput(request.responsesToolBindings).response({
        output: [
          {
            type: "function_call",
            name: present(request.responsesToolBindings?.[0]).upstreamName,
            arguments: argumentsJson,
          },
        ],
      }),
    ).toThrow(/JSON object/);
  });
});
