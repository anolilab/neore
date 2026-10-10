/**
 * `vJsonValue` / `vJsonObject` replaced `v.any()` on client-authored JSON
 * arguments. These pin that they accept what a JSON wire carries and reject what
 * it cannot, so they stay a real check rather than a pass-through.
 */
import { v } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { vJsonObject, vJsonValue } from "./validators";

const nested = (depth: number): unknown => {
    let value: unknown = "leaf";

    for (let index = 0; index < depth; index += 1) {
        value = { content: [value] };
    }

    return value;
};

describe("vJsonValue", () => {
    it("accepts a ProseMirror-shaped document, primitives and null", () => {
        const doc = { content: [{ attrs: { level: 1 }, content: [{ text: "Hi", type: "text" }], type: "heading" }], type: "doc" };

        expect(vJsonValue.safeParse(doc).ok).toBe(true);
        expect(vJsonValue.safeParse(null).ok).toBe(true);
        expect(vJsonValue.safeParse("text").ok).toBe(true);
        expect(vJsonValue.safeParse(3.5).ok).toBe(true);
        expect(vJsonValue.safeParse(false).ok).toBe(true);
    });

    it("rejects values a JSON wire cannot carry", () => {
        expect(vJsonValue.safeParse(() => 1).ok).toBe(false);
        expect(vJsonValue.safeParse(new Date()).ok).toBe(false);
        expect(vJsonValue.safeParse(Number.NaN).ok).toBe(false);
        expect(vJsonValue.safeParse({ inner: undefined }).ok).toBe(false);
        expect(vJsonValue.safeParse(new Map()).ok).toBe(false);
    });

    it("rejects nesting past the depth cap and accepts nesting just under it", () => {
        expect(vJsonValue.safeParse(nested(100)).ok).toBe(true);
        expect(vJsonValue.safeParse(nested(1000)).ok).toBe(false);
    });

    it("is still optional when the key is absent", () => {
        expect(v.optional(vJsonValue).safeParse(undefined).ok).toBe(true);
    });
});

describe("vJsonObject", () => {
    it("accepts a plain JSON object", () => {
        expect(vJsonObject.safeParse({ id: "n1", position: { x: 0, y: 0 } }).ok).toBe(true);
    });

    it("rejects arrays, strings and null", () => {
        expect(vJsonObject.safeParse([]).ok).toBe(false);
        expect(vJsonObject.safeParse("x").ok).toBe(false);
        expect(vJsonObject.safeParse(null).ok).toBe(false);
    });
});
