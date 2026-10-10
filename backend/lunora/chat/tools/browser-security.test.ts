/**
 * Browser Security Tests
 *
 * Tests for SSRF protection: domain validation and private IP blocking.
 *
 * `validateDomain` and `isSafeUrl` are the REAL functions `browser-node.ts`
 * calls, imported from `./utilities`. They used to be re-implemented in this
 * file, which meant the suite could pass while the shipped guard regressed —
 * the opposite of what an SSRF suite is for. The guard moved to `utilities.ts`
 * precisely so it could be imported: `browser-node.ts` pulls in
 * `_generated/api`, which a unit test cannot load.
 *
 *
 * There used to be an "Evaluate script blocklist" suite here guarding an
 * `evaluate` action. That action no longer exists — the union in
 * `browser-node.ts` is navigate|screenshot|click|type|extract|scroll and no
 * blocklist ships anywhere — so the suite was asserting a locally-defined
 * function against a feature that had been removed. Deleted rather than left
 * looking like coverage.
 */
import { describe, expect, it } from "vitest";

import { isSafeUrl, validateDomain } from "./utilities";

describe("SSRF: validateDomain", () => {
    it("should allow valid public URLs", () => {
        expect(validateDomain("https://example.com")).toBeNull();
        expect(validateDomain("https://google.com/search?q=test")).toBeNull();
        expect(validateDomain("https://api.github.com/repos")).toBeNull();
    });

    it("should block localhost and loopback", () => {
        expect(validateDomain("http://localhost:3000")).not.toBeNull();
        expect(validateDomain("http://127.0.0.1:8080")).not.toBeNull();
        expect(validateDomain("http://0.0.0.0")).not.toBeNull();
    });

    it("should block IPv6 loopback", () => {
        expect(validateDomain("http://[::1]:3000")).not.toBeNull();
    });

    it("should block cloud metadata endpoints", () => {
        expect(validateDomain("http://169.254.169.254/latest/meta-data/")).not.toBeNull();
        expect(validateDomain("https://metadata.google.internal/computeMetadata/v1/")).not.toBeNull();
    });

    it("should block private IPv4 ranges (10.x.x.x)", () => {
        expect(validateDomain("http://10.0.0.1")).not.toBeNull();
        expect(validateDomain("http://10.255.255.255")).not.toBeNull();
    });

    it("should block private IPv4 ranges (172.16-31.x.x)", () => {
        expect(validateDomain("http://172.16.0.1")).not.toBeNull();
        expect(validateDomain("http://172.31.255.255")).not.toBeNull();
        // 172.15.x.x and 172.32.x.x should NOT be blocked (public ranges)
        expect(validateDomain("http://172.15.0.1")).toBeNull();
        expect(validateDomain("http://172.32.0.1")).toBeNull();
    });

    it("should block private IPv4 ranges (192.168.x.x)", () => {
        expect(validateDomain("http://192.168.0.1")).not.toBeNull();
        expect(validateDomain("http://192.168.1.100")).not.toBeNull();
    });

    it("should block link-local addresses (169.254.x.x)", () => {
        expect(validateDomain("http://169.254.1.1")).not.toBeNull();
    });

    it("should block non-HTTP schemes", () => {
        expect(validateDomain("file:///etc/passwd")).not.toBeNull();
        expect(validateDomain("javascript:alert(1)")).not.toBeNull();
        expect(validateDomain("ftp://files.example.com")).not.toBeNull();
        expect(validateDomain("data:text/html,<h1>hi</h1>")).not.toBeNull();
    });

    it("should reject invalid URLs", () => {
        expect(validateDomain("not-a-url")).not.toBeNull();
        expect(validateDomain("")).not.toBeNull();
    });

    it("honours the per-user disable switch", () => {
        expect(validateDomain("https://example.com", { enabled: false })).not.toBeNull();
        expect(validateDomain("https://example.com", { enabled: true })).toBeNull();
    });

    it("permits only allowlisted domains when an allowlist is set", () => {
        const settings = { domainAllowlist: ["example.com", "*.corp.example"] };

        expect(validateDomain("https://example.com/x", settings)).toBeNull();
        expect(validateDomain("https://sub.corp.example", settings)).toBeNull();
        expect(validateDomain("https://corp.example", settings)).toBeNull();
        expect(validateDomain("https://evil.com", settings)).not.toBeNull();
        // A wildcard must not match a domain that merely ends with the string.
        expect(validateDomain("https://notcorp.example", settings)).not.toBeNull();
    });

    it("rejects blocklisted domains and their subdomains", () => {
        const settings = { domainBlocklist: ["*.tracker.example", "bad.example"] };

        expect(validateDomain("https://bad.example", settings)).not.toBeNull();
        expect(validateDomain("https://a.tracker.example", settings)).not.toBeNull();
        expect(validateDomain("https://fine.example", settings)).toBeNull();
    });
});

describe("isSafeUrl (the shipped guard, not a copy)", () => {
    it("allows ordinary public URLs", () => {
        expect(isSafeUrl("https://example.com")).toBe(true);
        expect(isSafeUrl("https://api.github.com/repos")).toBe(true);
    });

    it("blocks loopback and link-local, including cloud metadata", () => {
        for (const url of ["http://127.0.0.1", "http://localhost:3000", "http://0.0.0.0", "http://169.254.169.254", "http://metadata.google.internal"]) {
            expect(isSafeUrl(url), url).toBe(false);
        }
    });

    it("blocks private ranges", () => {
        for (const url of ["http://10.0.0.1", "http://172.16.0.1", "http://192.168.1.1"]) {
            expect(isSafeUrl(url), url).toBe(false);
        }
    });

    it("blocks non-http schemes", () => {
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<script>"]) {
            expect(isSafeUrl(url), url).toBe(false);
        }
    });

    /**
     * The reason the local copy above is not good enough: it compares hostnames
     * as strings, so every one of these reaches a different code path in the
     * real implementation and none of them is covered by the copy.
     */
    it("blocks alternate encodings of loopback that a string compare would miss", () => {
        for (const url of ["http://2130706433", "http://0x7f000001", "http://017700000001", "http://127.1", "http://[::1]"]) {
            expect(isSafeUrl(url), url).toBe(false);
        }
    });

    /**
     * `http://[::ffff:127.0.0.1]` reached the browser until this suite started
     * exercising the real function. The mapped-address check existed but was
     * unreachable: it matched the dotted-quad tail, and the URL parser rewrites
     * that to hex (`[::ffff:7f00:1]`) before the check ever sees it.
     */
    it("blocks IPv4-mapped IPv6, which the URL parser normalises to hex", () => {
        for (const url of ["http://[::ffff:127.0.0.1]", "http://[::ffff:10.0.0.1]", "http://[::ffff:192.168.1.1]", "http://[::ffff:169.254.169.254]"]) {
            expect(isSafeUrl(url), url).toBe(false);
        }
    });

    it("still allows a mapped PUBLIC address", () => {
        expect(isSafeUrl("http://[::ffff:8.8.8.8]")).toBe(true);
        expect(isSafeUrl("http://[2606:4700:4700::1111]")).toBe(true);
    });
});
