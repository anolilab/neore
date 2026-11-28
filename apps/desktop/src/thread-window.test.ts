import { describe, expect, it } from "vitest";

import { pageWindowUrl, threadWindowUrl } from "./thread-window.js";

const origin = new URL("https://chat.example.test/");

describe("pageWindowUrl", () => {
    it("builds the page route on the site origin", () => {
        expect(pageWindowUrl(origin, "abc_DEF-123")?.href).toBe("https://chat.example.test/pages/abc_DEF-123");
    });

    it("refuses the same ids a thread refuses", () => {
        expect(pageWindowUrl(origin, "a".repeat(129))).toBeUndefined();
        expect(pageWindowUrl(origin, "../settings")).toBeUndefined();
        expect(pageWindowUrl(origin, "a b")).toBeUndefined();
        expect(pageWindowUrl(origin, undefined)).toBeUndefined();
        expect(pageWindowUrl(origin, 42)).toBeUndefined();
    });
});

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
