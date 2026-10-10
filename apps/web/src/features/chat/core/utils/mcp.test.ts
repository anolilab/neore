import { describe, expect, it } from "vitest";

import { getServerInitials } from "./mcp";

describe("getServerInitials", () => {
    it("should extract initials from multi-word names", () => {
        expect(getServerInitials("Brave Search")).toBe("BS");
        expect(getServerInitials("Google Maps")).toBe("GM");
        expect(getServerInitials("My Custom Server")).toBe("MC");
    });

    it("should use first two chars for single-word names", () => {
        expect(getServerInitials("Scira")).toBe("SC");
        expect(getServerInitials("Redis")).toBe("RE");
    });

    it("should handle hyphenated names", () => {
        expect(getServerInitials("my-server")).toBe("MS");
    });

    it("should handle underscored names", () => {
        expect(getServerInitials("my_server")).toBe("MS");
    });

    it("should handle dot-separated names", () => {
        expect(getServerInitials("my.server")).toBe("MS");
    });

    it("should handle slash-separated names", () => {
        expect(getServerInitials("my/server")).toBe("MS");
    });

    it("should uppercase the result", () => {
        expect(getServerInitials("lower case")).toBe("LC");
        expect(getServerInitials("already")).toBe("AL");
    });

    it("should handle leading/trailing whitespace", () => {
        expect(getServerInitials("  Brave Search  ")).toBe("BS");
    });

    it("should handle single character names", () => {
        expect(getServerInitials("X")).toBe("X");
    });

    it("should handle empty string", () => {
        expect(getServerInitials("")).toBe("");
    });
});
