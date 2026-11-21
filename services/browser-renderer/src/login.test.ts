import { describe, expect, it } from "vitest";

import { withoutSecret } from "./login";

const SECRET = "p@ss wörd{1}&<x>";

const PERCENT_ESCAPE_RE = /%[0-9A-F]{2}/g;

const LEFT_AROUND_RE = /^token=[\w+/-]{0,4}\[password\][\w+/=-]{0,4}$/;

const base64 = (text: string): string => Buffer.from(text).toString("base64");

describe(withoutSecret, () => {
    it.each([
        ["raw", SECRET],
        ["URL-encoded", encodeURIComponent(SECRET)],
        ["URL-encoded, lowercase escapes", encodeURIComponent(SECRET).replaceAll(PERCENT_ESCAPE_RE, (escape) => escape.toLowerCase())],
        ["URL-encoded, unreserved characters escaped too", [...new TextEncoder().encode(SECRET)].map((byte) => `%${byte.toString(16)}`).join("")],
        ["form-encoded", new URLSearchParams({ p: SECRET }).toString().slice(2)],
        ["HTML-escaped", SECRET.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")],
        ["HTML numeric entities", [...SECRET].map((character) => `&#${character.codePointAt(0)};`).join("")],
        ["HTML hex entities", [...SECRET].map((character) => `&#X${character.codePointAt(0)?.toString(16).toUpperCase()};`).join("")],
    ])("hides the %s password", (_name, spelling) => {
        const scrubbed = withoutSecret(`Welcome ${spelling} back`, SECRET);

        expect(scrubbed).toBe("Welcome [password] back");
    });

    it.each([
        ["base64", (text: string) => base64(text)],
        ["base64url", (text: string) => base64(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")],
    ])("hides a %s password at every byte alignment", (_name, encode) => {
        for (const prefix of ["", "a", "ab"]) {
            // What is left either side is the prefix's and the suffix's own characters, at most a few.
            expect(withoutSecret(`token=${encode(`${prefix}${SECRET}!`)}`, SECRET)).toMatch(LEFT_AROUND_RE);
        }
    });

    it("keeps text without the password", () => {
        expect(withoutSecret("https://example.com/home?p=other", SECRET)).toBe("https://example.com/home?p=other");
    });
});
