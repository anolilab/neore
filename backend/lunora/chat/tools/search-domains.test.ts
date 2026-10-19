import { describe, expect, it } from "vitest";

import { filterBlockedResults, filterIncludeDomains, mergeExcludeDomains, normalizeSearchDomainBlocklist, toSearchDomain } from "./search-domains";

describe("toSearchDomain", () => {
    it.each([
        ["example.com", "example.com"],
        ["https://www.Example.com/path?q=1", "example.com"],
        ["  docs.example.org  ", "docs.example.org"],
        ["https://example.com:8080", "example.com"],
        ["example.com.", "example.com"],
    ])("reads %j as %j", (input, expected) => {
        expect(toSearchDomain(input)).toBe(expected);
    });

    it.each(["", " ".repeat(3), "localhost", "not a domain", "exa mple.com", "192.0.2.1", "https://", "a..b.com", "-bad.com"])("rejects %j", (input) => {
        expect(toSearchDomain(input)).toBeUndefined();
    });
});

describe("normalizeSearchDomainBlocklist", () => {
    it("dedupes, lowercases and reports junk without dropping valid entries", () => {
        const result = normalizeSearchDomainBlocklist(["Example.com", "https://example.com/x", "", "junk value", "news.test.org"]);

        expect(result).toStrictEqual({ domains: ["example.com", "news.test.org"], invalid: ["junk value"] });
    });
});

describe("filterBlockedResults", () => {
    const results = [
        { url: "https://example.com/a" },
        { url: "https://www.example.com/b" },
        { url: "https://docs.example.com/c" },
        { url: "https://notexample.com/d" },
        { url: "https://other.org/e" },
        { url: "not a url" },
    ];

    it("drops the blocked host and its subdomains, keeps lookalikes, drops unparseable URLs", () => {
        expect(filterBlockedResults(results, ["example.com"]).map((r) => r.url)).toStrictEqual(["https://notexample.com/d", "https://other.org/e"]);
    });

    it("is a copy when the blocklist is empty", () => {
        expect(filterBlockedResults(results, [])).toHaveLength(results.length);
    });
});

describe("mergeExcludeDomains", () => {
    it("keeps the model's excludes and adds the whole user list once", () => {
        expect(mergeExcludeDomains(["spam.io", "example.com"], ["example.com", "ads.net"])).toStrictEqual(["spam.io", "example.com", "ads.net"]);
    });
});

describe("filterIncludeDomains", () => {
    it("removes blocked includes, including subdomains of a blocked host", () => {
        expect(filterIncludeDomains(["docs.example.com", "python.org"], ["example.com"])).toStrictEqual(["python.org"]);
    });

    it("leaves a non-hostname include as the model sent it", () => {
        expect(filterIncludeDomains(["*.weird"], ["example.com"])).toStrictEqual(["*.weird"]);
    });

    it("returns empty when every include was blocked, so the caller can skip the search", () => {
        expect(filterIncludeDomains(["docs.example.com"], ["example.com"])).toStrictEqual([]);
    });
});
