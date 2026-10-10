import { describe, expect, it } from "vitest";

import { getValidThreadId, isValidThreadId, resolveThreadId } from "./thread-id";

describe("isValidThreadId", () => {
    it("should return true for valid thread IDs", () => {
        expect(isValidThreadId("abc123")).toBe(true);
        expect(isValidThreadId("thread_xyz")).toBe(true);
    });

    it("should return false for undefined/null", () => {
        expect(isValidThreadId(undefined)).toBe(false);
        expect(isValidThreadId(null)).toBe(false);
    });

    it("should return false for empty string", () => {
        expect(isValidThreadId("")).toBe(false);
    });

    it("should return false for 'default'", () => {
        expect(isValidThreadId("default")).toBe(false);
    });
});

describe("getValidThreadId", () => {
    it("should return the thread ID when valid", () => {
        expect(getValidThreadId("abc123")).toBe("abc123");
    });

    it("should return undefined for invalid IDs", () => {
        expect(getValidThreadId(undefined)).toBeUndefined();
        expect(getValidThreadId(null)).toBeUndefined();
        expect(getValidThreadId("")).toBeUndefined();
        expect(getValidThreadId("default")).toBeUndefined();
    });
});

describe("resolveThreadId", () => {
    it("should return primary thread ID when valid", () => {
        expect(resolveThreadId("primary", "fallback")).toBe("primary");
    });

    it("should return fallback when primary is invalid", () => {
        expect(resolveThreadId(undefined, "fallback")).toBe("fallback");
        expect(resolveThreadId(null, "fallback")).toBe("fallback");
        expect(resolveThreadId("", "fallback")).toBe("fallback");
    });

    it("should return undefined when both are invalid", () => {
        expect(resolveThreadId(undefined, undefined)).toBeUndefined();
        expect(resolveThreadId(null, null)).toBeUndefined();
        expect(resolveThreadId("", "")).toBeUndefined();
    });

    it("should reject 'default' in fallback", () => {
        expect(resolveThreadId(undefined, "default")).toBeUndefined();
    });
});
