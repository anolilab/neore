import { describe, expect, it } from "vitest";

import { withoutSecret, withPassword } from "./login";

const SECRET = "p@ss wörd{1}&<x>";

const PERCENT_ESCAPE_RE = /%[0-9A-F]{2}/g;

const LEFT_AROUND_RE = /^token=[\w%+/-]{0,6}\[password\][\w%+/=-]{0,9}$/;

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
        ["URL-encoded base64", (text: string) => encodeURIComponent(base64(text))],
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

describe(withPassword, () => {
    const STAND = "Xq7Rk2Lm9Pz4Wv8T";
    const FIELD = { name: "pw", stand: STAND };
    const part = (name: string, value: string) => `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

    it("puts the password into the URL-encoded password field", () => {
        const filled = withPassword(Buffer.from(`user=ann&pw=${STAND}`), "application/x-www-form-urlencoded", FIELD, SECRET);

        expect(Object.fromEntries(new URLSearchParams(filled?.toString() ?? ""))).toStrictEqual({ pw: SECRET, user: "ann" });
    });

    it("puts the password into the multipart password field", () => {
        const filled = withPassword(Buffer.from(`${part("user", "ann")}${part("pw", STAND)}--b--\r\n`), 'multipart/form-data; boundary="b"', FIELD, SECRET);

        expect(filled?.toString()).toBe(`${part("user", "ann")}${part("pw", SECRET)}--b--\r\n`);
    });

    it.each([
        ["the password field lost the stand-in", "application/x-www-form-urlencoded", `pw=${STAND.slice(1)}`],
        ["another field holds the stand-in", "application/x-www-form-urlencoded", `bio=${STAND}`],
        ["the stand-in is copied into another field too", "application/x-www-form-urlencoded", `user=${STAND}&pw=${STAND}`],
        ["a multipart stand-in is in another field", 'multipart/form-data; boundary="b"', `${part("bio", STAND)}--b--\r\n`],
        ["the body is plain text", "text/plain", `pw=${STAND}`],
    ])("sends nothing when %s", (_why, type, body) => {
        expect(withPassword(Buffer.from(body), type, FIELD, SECRET)).toBeNull();
    });
});
