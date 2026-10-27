import { describe, expect, it } from "vitest";

import { threadWindowUrl } from "./thread-window.js";

const origin = new URL("https://chat.example.test/");

describe("threadWindowUrl", () => {
    it("builds the thread route on the site origin", () => {
        expect(threadWindowUrl(origin, "abc_DEF-123")?.href).toBe("https://chat.example.test/chat/abc_DEF-123");
    });

    it("accepts the longest id, and refuses one character more", () => {
        expect(threadWindowUrl(origin, "a".repeat(128))).toBeDefined();
        expect(threadWindowUrl(origin, "a".repeat(129))).toBeUndefined();
    });

    it.each(["", "../settings", "a/b", "a?x=1", "a#frag", "a b", "a.b", "é"])("refuses %j", (id) => {
        expect(threadWindowUrl(origin, id)).toBeUndefined();
    });

    it("refuses anything that is not a string", () => {
        expect(threadWindowUrl(origin, undefined)).toBeUndefined();
        expect(threadWindowUrl(origin, 42)).toBeUndefined();
        expect(threadWindowUrl(origin, { id: "abc" })).toBeUndefined();
    });
});
