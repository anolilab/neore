import type { Page } from "@cloudflare/playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signIn, standIn, withoutSecret, withPassword } from "./login";

const SECRET = "p@ss wörd{1}&<x>";

const NEVER = new Promise<never>(() => {
    // Never settles.
});

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

    it("withholds a text that carries the password encoded twice, which no replacement reaches", () => {
        expect(withoutSecret(`/home?returnTo=${encodeURIComponent(encodeURIComponent(SECRET))} at 100%`, SECRET)).toBe("[withheld: it holds the password]");
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

describe(standIn, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("draws a byte past the alphabet again rather than wrap it onto a letter, which would favour the first ones", () => {
        let draws = 0;

        vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
            // 254 is past the 62 letters and digits; then 0, the first of them.
            (array as Uint8Array).fill(draws === 0 ? 254 : 0);
            draws += 1;

            return array;
        });

        expect(standIn(4, "secret")).toBe("AAAA");
    });
});

describe(signIn, () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("types nothing when the username holds the password, in any case", async () => {
        const page = { url: () => "about:blank" } as unknown as Page;
        const result = await signIn(page, {
            deadline: Date.now() + 30_000,
            navTimeout: 10_000,
            origin: "https://id.example",
            pageTimeout: 5000,
            password: SECRET,
            url: "https://id.example/login",
            username: `ann-${SECRET.toUpperCase()}`,
        });

        expect(result).toMatchObject({ error: expect.stringContaining("username holds the saved password"), submitted: false, success: false });
    });

    it("closes the session when the lock's setup does not settle in time", async () => {
        vi.useFakeTimers();

        const close = vi.fn(async () => undefined);
        // The socket gate's route, the setup's first step, never settles.
        const page = {
            close,
            context: () => {
                return { routeWebSocket: async () => NEVER };
            },
            url: () => "https://id.example/login",
        } as unknown as Page;
        const signedIn = signIn(page, {
            deadline: Date.now() + 30_000,
            navTimeout: 10_000,
            origin: "https://id.example",
            pageTimeout: 5000,
            password: SECRET,
            url: "https://id.example/login",
            username: "ann",
        });

        await vi.advanceTimersByTimeAsync(4999);

        expect(close).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        await expect(signedIn).resolves.toMatchObject({
            error: expect.stringContaining("could not be locked"),
            sessionClosed: true,
            submitted: false,
            success: false,
        });
        expect(close).toHaveBeenCalledOnce();
    });
});
