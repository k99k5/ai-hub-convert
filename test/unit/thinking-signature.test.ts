import { describe, expect, it, vi } from "vitest";
import {
  createSyntheticThinkingSignature,
  finalizeThinkingBlock,
} from "../../src/policies/thinking-signature.js";

const FIXED_UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("createSyntheticThinkingSignature", () => {
  it("encodes a 36-character UUID v4 as standard Base64", () => {
    const signature = createSyntheticThinkingSignature(() => FIXED_UUID);

    expect(signature).toBe("MTIzZTQ1NjctZTg5Yi00MmQzLWE0NTYtNDI2NjE0MTc0MDAw");
    expect(signature).toHaveLength(48);
    expect(Buffer.from(signature, "base64").toString("utf8")).toBe(FIXED_UUID);
  });
});

describe("finalizeThinkingBlock", () => {
  it("generates one synthetic signature when enabled and the signature is missing", () => {
    const uuidFactory = vi.fn(() => FIXED_UUID);
    const block = Object.freeze({ text: "consider this" });

    const result = finalizeThinkingBlock(block, { enabled: true, uuidFactory });

    expect(result).toEqual({
      text: "consider this",
      signature: "MTIzZTQ1NjctZTg5Yi00MmQzLWE0NTYtNDI2NjE0MTc0MDAw",
      synthetic: true,
    });
    expect(result).not.toBe(block);
    expect(Object.isFrozen(result)).toBe(true);
    expect(uuidFactory).toHaveBeenCalledTimes(1);
  });

  it("treats an empty real signature as missing", () => {
    const uuidFactory = vi.fn(() => FIXED_UUID);
    const block = { text: "consider this", signature: "" };

    const result = finalizeThinkingBlock(block, { enabled: true, uuidFactory });

    expect(result).toMatchObject({
      signature: "MTIzZTQ1NjctZTg5Yi00MmQzLWE0NTYtNDI2NjE0MTc0MDAw",
      synthetic: true,
    });
    expect(uuidFactory).toHaveBeenCalledTimes(1);
    expect(block).toEqual({ text: "consider this", signature: "" });
  });

  it("preserves a non-empty real signature without invoking the factory", () => {
    const uuidFactory = vi.fn(() => FIXED_UUID);
    const block = { text: "consider this", signature: "provider-signature" };

    const result = finalizeThinkingBlock(block, { enabled: true, uuidFactory });

    expect(result).toEqual({
      text: "consider this",
      signature: "provider-signature",
      synthetic: false,
    });
    expect(result).not.toBe(block);
    expect(uuidFactory).not.toHaveBeenCalled();
  });

  it("omits a missing or empty signature when synthetic signatures are disabled", () => {
    const uuidFactory = vi.fn(() => FIXED_UUID);

    expect(finalizeThinkingBlock({ text: "one" }, { enabled: false, uuidFactory })).toEqual({
      text: "one",
    });
    expect(
      finalizeThinkingBlock(
        { text: "two", signature: "", synthetic: true },
        { enabled: false, uuidFactory },
      ),
    ).toEqual({ text: "two" });
    expect(uuidFactory).not.toHaveBeenCalled();
  });

  it("returns a new object without changing the input", () => {
    const block = Object.freeze({
      text: "consider this",
      signature: "provider-signature",
      synthetic: false,
    });

    const result = finalizeThinkingBlock(block, { enabled: false });

    expect(result).toEqual(block);
    expect(result).not.toBe(block);
  });
});
