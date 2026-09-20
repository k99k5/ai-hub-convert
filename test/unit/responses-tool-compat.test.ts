import { describe, expect, it } from "vitest";
import { decodeResponsesRequest } from "../../src/protocols/openai-responses/request-decode.js";
import { encodeResponsesChatRequest } from "../../src/protocols/openai-responses/chat-bridge.js";
import { normalizeResponsesInput } from "../../src/protocols/openai-responses/input-normalize.js";
import { ResponsesToolOutput } from "../../src/protocols/openai-responses/tool-compat.js";
import { ResponsesStreamEncoder } from "../../src/protocols/openai-responses/stream-encode.js";

const fn = { type: "function", name: "run", parameters: { type: "object", properties: {} } };
const custom = {
  type: "custom",
  name: "exec",
  format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
};
const group = (name: string, tools: unknown[] = [fn]) => ({
  type: "namespace",
  name,
  description: `${name} tools`,
  tools,
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a tool binding or event");
  return value;
}

describe("Codex Responses tool compatibility", () => {
  it("keeps names distinct and stable across namespace, tool kind and declaration order", () => {
    const tools = [fn, group("left"), group("right"), { type: "custom", name: "run" }];
    const first = decodeResponsesRequest({ model: "m", tools });
    const second = decodeResponsesRequest({ model: "m", tools: [...tools].reverse() });
    expect(new Set(first.tools.map((tool) => "name" in tool && tool.name)).size).toBe(4);
    expect(second.responsesToolBindings).toEqual(
      [...present(first.responsesToolBindings)].reverse(),
    );
    expect(first.tools[0]).toMatchObject({ name: "run" });
    expect(
      present(first.responsesToolBindings).every((binding) =>
        /^[a-zA-Z0-9_-]{1,64}$/.test(binding.upstreamName),
      ),
    ).toBe(true);
    const body = encodeResponsesChatRequest(first);
    expect(body.tools?.[1]?.function.description).toContain("left.run");
  });

  it("restores function namespaces and preserves custom raw text, including empty input", () => {
    const request = decodeResponsesRequest({
      model: "m",
      tools: [group("functions", [fn, custom])],
    });
    const output = new ResponsesToolOutput(request.responsesToolBindings);
    const functionBinding = present(request.responsesToolBindings?.[0]);
    const customBinding = present(request.responsesToolBindings?.[1]);
    const raw = 'text("中😀\\\\"\n");';
    const response = output.response({
      output: [
        {
          type: "function_call",
          call_id: "f",
          name: functionBinding.upstreamName,
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "c",
          name: customBinding.upstreamName,
          arguments: JSON.stringify({ input: raw }),
        },
        {
          type: "function_call",
          call_id: "e",
          name: customBinding.upstreamName,
          arguments: '{"input":""}',
        },
      ],
    });
    expect(response.output).toEqual([
      { type: "function_call", call_id: "f", name: "run", namespace: "functions", arguments: "{}" },
      { type: "custom_tool_call", call_id: "c", name: "exec", namespace: "functions", input: raw },
      { type: "custom_tool_call", call_id: "e", name: "exec", namespace: "functions", input: "" },
    ]);
    const replay = encodeResponsesChatRequest(
      decodeResponsesRequest({
        model: "m",
        tools: [group("functions", [fn, custom])],
        input: [
          ...(response.output as unknown[]),
          {
            type: "custom_tool_call_output",
            call_id: "c",
            output: [{ type: "input_text", text: "done" }],
          },
        ],
      }),
    );
    expect(replay.messages[0]).toMatchObject({
      tool_calls: [
        { function: { name: functionBinding.upstreamName, arguments: "{}" } },
        {
          function: {
            name: customBinding.upstreamName,
            arguments: JSON.stringify({ input: raw }),
          },
        },
        { function: { name: customBinding.upstreamName, arguments: '{"input":""}' } },
      ],
    });
    expect(replay.messages[1]).toEqual({ role: "tool", tool_call_id: "c", content: "done" });
  });

  it("extracts additional_tools and applies later declarations and namespaced choices", () => {
    const input = [
      { type: "additional_tools", role: "developer", tools: [group("functions", [custom])] },
      { type: "message", role: "user", content: "run" },
      {
        type: "additional_tools",
        role: "developer",
        tools: [group("functions", [{ ...custom, description: "updated" }])],
      },
    ];
    const request = decodeResponsesRequest({
      model: "m",
      input,
      tool_choice: { type: "custom", namespace: "functions", name: "exec" },
    });
    expect(request.messages).toHaveLength(1);
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]).toMatchObject({
      type: "function",
      description: expect.stringContaining("updated"),
    });
    expect(request.toolChoice).toEqual({
      type: "function",
      name: present(request.responsesToolBindings?.[0]).upstreamName,
    });
    const allowed = decodeResponsesRequest({
      model: "m",
      tools: [fn, group("functions", [custom])],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "custom", namespace: "functions", name: "exec" }],
      },
    });
    expect(allowed.tools).toHaveLength(1);
    expect(allowed.tools[0]).toMatchObject({
      name: present(request.responsesToolBindings?.[0]).upstreamName,
    });
  });

  it("retains understood history fields without filtering application JSON", () => {
    const parameters = { type: "object", properties: { client_extra: { type: "string" } } };
    const input = [
      {
        type: "additional_tools",
        role: "developer",
        client_extra: "drop",
        tools: [
          group("functions", [
            { ...fn, parameters, client_extra: "drop" },
            { ...custom, format: { ...custom.format, client_extra: "drop" } },
          ]),
        ],
      },
      {
        type: "custom_tool_call",
        name: "exec",
        namespace: "functions",
        call_id: "c",
        input: '{"client_extra":"keep"}',
        client_extra: "drop",
      },
      {
        type: "custom_tool_call_output",
        call_id: "c",
        output: [{ type: "input_text", text: "done", client_extra: "drop" }],
        client_extra: "drop",
      },
    ];
    decodeResponsesRequest({ model: "m", input });
    const normalized = normalizeResponsesInput(input);
    expect(JSON.stringify(normalized)).not.toContain('"drop"');
    expect(JSON.stringify(normalized)).toContain('"client_extra":{"type":"string"}');
    expect(normalized[1]).toHaveProperty("namespace", "functions");
    expect(normalized[1]).toHaveProperty("input", '{"client_extra":"keep"}');
    expect(decodeResponsesRequest({ model: "m", input: normalized })).toEqual(
      decodeResponsesRequest({ model: "m", input }),
    );
  });

  it("emits native custom events with contiguous sequence numbers for fragmented arguments", () => {
    const request = decodeResponsesRequest({ model: "m", tools: [custom] });
    const output = new ResponsesToolOutput(request.responsesToolBindings);
    const encoder = new ResponsesStreamEncoder();
    const frames: ReturnType<typeof encoder.encode> = [];
    const emit = (event: Parameters<typeof encoder.encode>[0]) =>
      frames.push(...encoder.encode(event).flatMap((frame) => output.frames(frame)));
    emit({ type: "response_start", id: "r", model: "m" });
    emit({
      type: "content_start",
      index: 0,
      itemId: "ctc_1",
      content: {
        type: "function_call",
        id: "c",
        name: present(request.responsesToolBindings?.[0]).upstreamName,
        arguments: "",
      },
    });
    const text = "line 1\nline 2 😀 \\";
    for (const delta of JSON.stringify({ input: text }))
      emit({ type: "function_arguments_delta", index: 0, delta });
    emit({ type: "content_stop", index: 0 });
    emit({
      type: "response_complete",
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(frames.map((frame) => frame.data.sequence_number)).toEqual(
      frames.map((_, index) => index),
    );
    expect(frames.some((frame) => frame.event.startsWith("response.function_call_arguments"))).toBe(
      false,
    );
    expect(
      frames.find((frame) => frame.event === "response.custom_tool_call_input.delta")?.data.delta,
    ).toBe(text);
    expect(
      frames.find((frame) => frame.event === "response.custom_tool_call_input.done")?.data.input,
    ).toBe(text);
    expect(frames.at(-1)?.data.response).toMatchObject({
      output: [{ type: "custom_tool_call", input: text, name: "exec" }],
    });
  });

  it.each([
    { tools: [{ type: "custom", name: "x".repeat(65) }] },
    { tools: [group("functions", [{ ...fn, name: "x".repeat(65) }])] },
    { tools: [{ type: "namespace", name: "bad", tools: [group("nested")] }] },
    { tools: [group("bad", [{ type: "file_search" }])] },
    { tools: [{ ...custom, format: { type: "grammar", syntax: "unknown", definition: "x" } }] },
    { tools: [{ ...custom, format: { type: "grammar", syntax: "lark" } }] },
    { input: [{ type: "additional_tools", role: "user", tools: [] }] },
    { input: [{ type: "additional_tools", role: "developer", tools: null }] },
    { input: [{ type: "custom_tool_call", name: "exec", call_id: "c", input: {} }] },
    { tools: [custom], tool_choice: { type: "custom", name: "missing" } },
    { tools: [{ type: "file_search" }] },
  ])("rejects unsupported or malformed formats before forwarding: %j", (value) => {
    expect(() => decodeResponsesRequest({ model: "m", ...value })).toThrow();
  });

  it("rejects aliases that collide with a declared ordinary function", () => {
    const request = decodeResponsesRequest({ model: "m", tools: [custom] });
    expect(() =>
      decodeResponsesRequest({
        model: "m",
        tools: [custom, { ...fn, name: present(request.responsesToolBindings?.[0]).upstreamName }],
      }),
    ).toThrow(/Conflicting/);
  });

  it.each([
    '{"input":',
    '{"input":42}',
    '{"input":"x","extra":true}',
    "{}",
  ])("rejects malformed custom arguments instead of exposing an executable call: %s", (argumentsJson) => {
    const request = decodeResponsesRequest({ model: "m", tools: [custom] });
    const output = new ResponsesToolOutput(request.responsesToolBindings);
    expect(() =>
      output.response({
        output: [
          {
            type: "function_call",
            name: present(request.responsesToolBindings?.[0]).upstreamName,
            arguments: argumentsJson,
          },
        ],
      }),
    ).toThrow(/exactly one string/);
  });
});
