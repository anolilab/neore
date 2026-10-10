import { describe, expect, it } from "vitest";

import cn from "./cn";

describe("cn", () => {
    it("should merge class names", () => {
        expect(cn("foo", "bar")).toBe("foo bar");
    });

    it("should handle conditional classes", () => {
        expect(cn("base", false, "visible")).toBe("base visible");
        expect(cn("base", "active")).toBe("base active");
    });

    it("should handle undefined and null", () => {
        expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
    });

    it("should merge conflicting Tailwind classes", () => {
        // twMerge should resolve conflicts by keeping the last class
        expect(cn("px-4", "px-2")).toBe("px-2");
        expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    });

    it("should handle empty arguments", () => {
        expect(cn()).toBe("");
        expect(cn("")).toBe("");
    });

    it("should handle arrays", () => {
        expect(cn(["foo", "bar"])).toBe("foo bar");
    });

    it("should handle object syntax", () => {
        expect(cn({ active: true, disabled: false })).toBe("active");
    });
});
