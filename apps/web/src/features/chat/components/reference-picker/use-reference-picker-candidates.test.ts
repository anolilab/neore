import { describe, expect, it } from "vitest";

import { isReferencePickerReady } from "./use-reference-picker-candidates";

describe("isReferencePickerReady", () => {
    it("is false when the picker is disabled, regardless of scope", () => {
        expect(isReferencePickerReady(false, "all")).toBe(false);
        expect(isReferencePickerReady(false, "thread", "t1")).toBe(false);
    });

    it("is true for scope=all without a threadId", () => {
        expect(isReferencePickerReady(true, "all")).toBe(true);
        expect(isReferencePickerReady(true, "all", undefined)).toBe(true);
    });

    it("is false for scope=thread without a threadId (would 400 on the server)", () => {
        expect(isReferencePickerReady(true, "thread")).toBe(false);
        expect(isReferencePickerReady(true, "thread", undefined)).toBe(false);
        expect(isReferencePickerReady(true, "thread", "")).toBe(false);
    });

    it("is true for scope=thread once a threadId is supplied", () => {
        expect(isReferencePickerReady(true, "thread", "thread_abc")).toBe(true);
    });
});
