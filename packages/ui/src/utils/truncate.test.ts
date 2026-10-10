import { describe, expect, it } from "vitest";

import truncate from "./truncate";

describe("truncate", () => {
    it("should return string as-is when shorter than length", () => {
        expect(truncate("hello", 10)).toBe("hello");
    });

    it("should return string as-is when exactly at length", () => {
        expect(truncate("hello", 5)).toBe("hello");
    });

    it("should truncate string and add ellipsis", () => {
        expect(truncate("hello world", 8)).toBe("hello...");
    });

    it("should handle minimum truncation length", () => {
        expect(truncate("abcdefg", 4)).toBe("a...");
    });

    it("should return null for null input", () => {
        expect(truncate(null, 10)).toBeNull();
    });

    it("should return null for undefined input", () => {
        expect(truncate(undefined, 10)).toBeNull();
    });

    it("should return empty string for empty string input", () => {
        expect(truncate("", 10)).toBe("");
    });

    it("should handle long strings", () => {
        const long = "a".repeat(100);
        const result = truncate(long, 20);

        expect(result).toHaveLength(20);
        expect(result!.endsWith("...")).toBe(true);
    });
});
