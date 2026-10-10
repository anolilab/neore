/**
 * The canonical `path?query` rule is what HMAC signatures are computed over, on
 * BOTH ends. It lived in four copies until now and drifted at least once, so the
 * properties that matter are pinned here rather than left to the call sites.
 */
import { describe, expect, it } from "vitest";

import { canonicalPathAndQuery } from "../lib/canonical-query.js";

const at = (href: string): string => canonicalPathAndQuery(new URL(href));

describe("canonicalPathAndQuery", () => {
    it("drops the query entirely when there is none", () => {
        // Not a trailing "?" — the verifier signs a bare path for these.
        expect(at("https://x.test/v1/chat")).toBe("/v1/chat");
    });

    it("orders parameters so a reordered replay produces the same string", () => {
        expect(at("https://x.test/p?b=2&a=1")).toBe(at("https://x.test/p?a=1&b=2"));
    });

    it("keeps path and query together", () => {
        expect(at("https://x.test/p?a=1")).toBe("/p?a=1");
    });

    it("distinguishes different values, so a swapped parameter breaks the signature", () => {
        expect(at("https://x.test/p?a=1")).not.toBe(at("https://x.test/p?a=2"));
    });

    it("orders by code unit, not locale", () => {
        // `localeCompare` would sort these differently in some locales, which
        // would canonicalise the same URL two ways on two machines.
        expect(at("https://x.test/p?B=1&a=2")).toBe("/p?B=1&a=2");
    });

    it("preserves repeated parameters", () => {
        expect(at("https://x.test/p?a=1&a=2")).toBe("/p?a=1&a=2");
    });
});
