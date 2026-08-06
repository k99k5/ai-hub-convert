import { describe, expect, it } from "vitest";
import {
  normalizeReadToolArguments,
  ReadToolArgumentsError,
} from "../../src/policies/read-tool.js";

describe("normalizeReadToolArguments", () => {
  it("returns bytes unchanged without parsing when disabled or used for another tool", () => {
    const raw = "{not json: secret-value}";

    expect(normalizeReadToolArguments("Read", raw, false)).toEqual({ json: raw, changed: false });
    expect(normalizeReadToolArguments("Write", raw, true)).toEqual({ json: raw, changed: false });
  });

  it("matches the Read tool name case-insensitively", () => {
    expect(normalizeReadToolArguments("rEaD", '{"pages":"","path":"a"}', true)).toEqual({
      json: '{"path":"a"}',
      changed: true,
    });
  });

  it.each([
    ['{ "pages" : "", "value":1}', '{  "value":1}'],
    ['{"a":1, "pages" : "" , "b":2}', '{"a":1,  "b":2}'],
    ['{"a":1, "pages":"" }', '{"a":1 }'],
    ['{ \n "pages":"" \t}', "{ \n  \t}"],
  ])("removes an empty pages property while preserving all other bytes", (raw, expected) => {
    expect(normalizeReadToolArguments("read", raw, true)).toEqual({
      json: expected,
      changed: true,
    });
  });

  it("preserves key order, number spelling, escapes, whitespace, and nested pages", () => {
    const raw = String.raw`{"large":9007199254740993123456789, "pages":"1-2", "nested":{"pages":"","quote":"a\\\"b"}, "exponent":1e+999}`;

    expect(normalizeReadToolArguments("read", raw, true)).toEqual({
      json: raw,
      changed: false,
    });
  });

  it("recognizes escaped top-level property names", () => {
    const raw = '{"\\u0070ages":"","nested":{"pages":""}}';

    expect(normalizeReadToolArguments("READ", raw, true)).toEqual({
      json: '{"nested":{"pages":""}}',
      changed: true,
    });
  });

  it("removes every empty top-level pages duplicate and keeps non-empty duplicates", () => {
    const raw = '{"pages":"", "keep":0, "pages":"", "pages":"", "pages":"1-3"}';

    const result = normalizeReadToolArguments("read", raw, true);

    expect(result).toEqual({
      json: '{ "keep":0,  "pages":"1-3"}',
      changed: true,
    });
    expect(JSON.parse(result.json)).toEqual({ keep: 0, pages: "1-3" });
  });

  it("removes a trailing run of empty pages duplicates without leaving a comma", () => {
    const raw = '{"keep":1, "pages":"",  "pages":"" }';

    expect(normalizeReadToolArguments("read", raw, true)).toEqual({
      json: '{"keep":1 }',
      changed: true,
    });
  });

  it("keeps an object valid when every property is an empty pages duplicate", () => {
    expect(normalizeReadToolArguments("read", '{"pages":"", "pages":""}', true)).toEqual({
      json: "{}",
      changed: true,
    });
  });

  it.each([
    "{}",
    '{"null":null,"true":true,"false":false}',
    '{"numbers":[0,-1,1.25,-2.5e+3,4E-2]}',
    String.raw`{"array":[[],{},"escaped\\n\\t\\u0041"],"nested":{"ok":true}}`,
  ])("accepts complete JSON token forms without rewriting them", (raw) => {
    expect(normalizeReadToolArguments("read", raw, true)).toEqual({ json: raw, changed: false });
  });

  it("rejects excessive nesting with a sanitized custom error", () => {
    const raw = `${'{"nested":'.repeat(101)}0${"}".repeat(101)}`;

    expect(() => normalizeReadToolArguments("read", raw, true)).toThrow(ReadToolArgumentsError);
  });

  it("rejects excessive array nesting with a sanitized custom error", () => {
    const raw = `{"nested":${"[".repeat(101)}0${"]".repeat(101)}}`;

    expect(() => normalizeReadToolArguments("read", raw, true)).toThrow(ReadToolArgumentsError);
  });

  it.each([
    "[]",
    "null",
    '{"pages":""} trailing-secret',
    '{"pages":"unterminated-secret}',
    '{"missing-colon" 1}',
    '{"trailing":true,}',
    '{"literal":tru}',
    '{"number":-}',
    '{"fraction":1.}',
    '{"exponent":1e+}',
    String.raw`{"escape":"\x"}`,
    String.raw`{"unicode":"\u12xz"}`,
    '{"array":[1,]}',
    '{"array":[1}',
  ])("throws a sanitized custom error for invalid Read arguments", (raw) => {
    try {
      normalizeReadToolArguments("read", raw, true);
      throw new Error("expected normalization to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ReadToolArgumentsError);
      expect((error as Error).message).not.toContain(raw);
      expect((error as Error).message).not.toContain("secret");
    }
  });
});
