import type { Page } from "@cloudflare/playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { signIn, standIn, standInFor, WITHHELD, withoutSecret, withPassword } from "./login";

const SECRET = "p@ss wörd{1}&<x>";

const NEVER = new Promise<never>(() => {
    // Never settles.
});

const PERCENT_ESCAPE_RE = /%[0-9A-F]{2}/g;

const base64 = (text: string): string => Buffer.from(text).toString("base64");

const encodedTimes = (text: string, times: number): string => (times === 0 ? text : encodedTimes(encodeURIComponent(text), times - 1));

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
        [String.raw`JS \u-escaped`, [...SECRET].map((character) => String.raw`\u` + (character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")).join("")],
        [
            String.raw`JS \u{}-escaped`,
            [...SECRET].map((character) => `${String.raw`\u`}{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`).join(""),
        ],
        [String.raw`JS \x-escaped`, [...SECRET].map((character) => String.raw`\x` + (character.codePointAt(0) ?? 0).toString(16).padStart(2, "0")).join("")],
    ])("withholds a text with the %s password whole", (_name, spelling) => {
        expect(withoutSecret(`Welcome ${spelling} back`, SECRET)).toBe(WITHHELD);
    });

    it("withholds an address whole, never marking which of the guesses in it is the password", () => {
        const address = `https://example.com/home?a=wrong-guess&b=${encodeURIComponent(SECRET)}&c=other`;

        expect(withoutSecret(address, SECRET)).toBe(WITHHELD);
    });

    it.each([
        ["base64", (text: string) => base64(text)],
        ["base64url", (text: string) => base64(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")],
        ["URL-encoded base64", (text: string) => encodeURIComponent(base64(text))],
    ])("withholds a text with a %s password at every byte alignment", (_name, encode) => {
        for (const prefix of ["", "a", "ab"]) {
            expect(withoutSecret(`token=${encode(`${prefix}${SECRET}!`)}`, SECRET)).toBe(WITHHELD);
        }
    });

    it.each([2, 6, 10])("withholds a text that carries the password encoded %i times, which no replacement reaches", (depth) => {
        expect(withoutSecret(`/home?returnTo=${encodedTimes(SECRET, depth)} at 100%`, SECRET)).toBe(WITHHELD);
    });

    it("withholds a text whose encoded password sits in a run of escapes with a byte that is no UTF-8", () => {
        const everyByteEscaped = [...new TextEncoder().encode(SECRET)].map((byte) => `%${byte.toString(16)}`).join("");

        expect(withoutSecret(`/home?returnTo=%FF${encodedTimes(everyByteEscaped, 2)}`, SECRET)).toBe(WITHHELD);
    });

    it.each([1, 2, 4])("withholds a password that holds an escape of its own, encoded %i more times", (depth) => {
        const secret = "x%41y";

        expect(withoutSecret(`q=${encodedTimes(secret, depth)}`, secret)).toBe(WITHHELD);
    });

    it("withholds a large text whose layers take longer to read through than its budget", () => {
        expect(withoutSecret(`${"a".repeat(1_000_000)}${encodedTimes("a b", 8)}`, SECRET)).toBe(WITHHELD);
    });

    it("withholds a text encoded more deeply than it is read through", () => {
        // Each layer escapes the first hex digit of the one below: no escape of `%` alone, so every layer takes a round.
        const layers = 40;

        expect(withoutSecret(`${"%".repeat(layers + 1)}${"3".repeat(layers)}41`, SECRET)).toBe(WITHHELD);
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

const THIRTEEN_DIGITS_RE = /^\d{13}$/u;

describe(standInFor, () => {
    const lengths = { length: 64, max: Infinity, min: 0 };
    // Run in the test only, on what the Worker built: the Worker itself never runs a page's pattern.
    const isMet = (pattern: string, value: string): boolean => new RegExp(`^(?:${pattern})$`, "v").test(value);

    it.each([
        ["A[A-Za-z0-9]{63}", 64],
        ["[0-9]*", 64],
        [String.raw`\d{4,16}`, 16],
        [".{8,}", 64],
        [String.raw`^[a-z]+\d?$`, 64],
        ["[A-Z]{2}[a-z0-9]{10,}?", 64],
    ])("builds a stand-in %s takes, every time", (pattern, length) => {
        for (let index = 0; index < 200; index++) {
            const stand = standInFor(pattern, "secret", lengths);

            expect(stand).toHaveLength(length);
            expect(isMet(pattern, stand ?? "")).toBe(true);
        }
    });

    it("refuses a pattern with groups at once, without running it, however it would backtrack", () => {
        // One run would backtrack past the test's time: none ends it in time but a refusal that never runs it.
        // Joined from parts: the test hands them to the code as text a page would set, and compiles neither.
        expect(standInFor(["(.+)", "+!"].join(""), "secret", lengths)).toBeNull();
        expect(standInFor(["(a|aa)", "*b"].join(""), "secret", lengths)).toBeNull();
        expect(standInFor(`${"[a-z]*".repeat(80)}!`, "secret", lengths)).toBeNull();
        expect(standInFor("a".repeat(5000), "secret", lengths)).toBeNull();
    });

    it.each([".*[!@#].*", "[^a-z]{8}", String.raw`(?=.*\d).{8,}`, String.raw`\p{L}+`])("refuses %s, the same way each time", (pattern) => {
        for (let index = 0; index < 20; index++) {
            expect(standInFor(pattern, "secret", lengths)).toBeNull();
        }
    });

    it("ignores a pattern the browser does not compile, as the browser does", () => {
        expect(standInFor(String.raw`[\w-]+`, "secret", lengths)).toHaveLength(64);
    });

    it("keeps to the field's minlength and maxlength", () => {
        expect(standInFor("[0-9]*", "1234", { length: 64, max: 13, min: 0 })).toHaveLength(13);
        expect(standInFor(String.raw`\d{13}`, "1234", { length: 64, max: 13, min: 0 })).toMatch(THIRTEEN_DIGITS_RE);
        expect(standInFor(null, "secret", { length: 64, max: Infinity, min: 80 })).toHaveLength(80);
        expect(standInFor(String.raw`\d{4}`, "secret", { length: 64, max: Infinity, min: 6 })).toBeNull();
    });

    it("refuses a stand-in a pattern or minlength would stretch past 1024 characters, or keep under 4", () => {
        expect(standInFor(String.raw`\d{9999}`.repeat(50), "secret", lengths)).toBeNull();
        expect(standInFor(null, "secret", { length: 64, max: Infinity, min: 2 ** 31 - 1 })).toBeNull();
        expect(standInFor(String.raw`\d{2000,}`, "secret", lengths)).toBeNull();
        expect(standInFor("[0-9]*", "secret", lengths)).toHaveLength(64);
        expect(standInFor(String.raw`\d+`, "secret", { length: 64, max: Infinity, min: 1500 })).toBeNull();

        for (const pattern of ["", "^$", "a{0}", "[0-9]{3}", String.raw`\d`]) {
            expect(standInFor(pattern, "secret", lengths)).toBeNull();
        }

        expect(standInFor(".*", "secret", { length: 64, max: 2, min: 0 })).toBeNull();
    });

    it.each([
        ["a literal", "hunter2"],
        ["a short PIN", String.raw`\d{4}`],
        ["a class of two", "[ab]{39}"],
        ["literals around a narrow step", "hunter[0-9]{2}"],
    ])("refuses a field with fewer than 2^40 stand-ins (%s) the same way whatever the password", (_kind, pattern) => {
        for (const password of ["hunter2", "hunter42", "1234", "a".repeat(39), "other"]) {
            expect(standInFor(pattern, password, lengths)).toBeNull();
        }
    });

    it("refuses a maxlength too short for 2^40 stand-ins, and takes one just long enough", () => {
        // 62^6 is under 2^40, 62^7 over it; 10^12 under, 10^13 over.
        expect(standInFor(null, "secret", { length: 64, max: 6, min: 0 })).toBeNull();
        expect(standInFor(null, "secret", { length: 64, max: 7, min: 0 })).toHaveLength(7);
        expect(standInFor("[0-9]*", "1234", { length: 64, max: 12, min: 0 })).toBeNull();
    });

    it("draws again, without refusing, a stand-in that comes out as the password", () => {
        // The draw is the only randomness: every byte 0 makes a stand-in of the first character alone.
        const bytes = vi.spyOn(crypto, "getRandomValues");

        bytes.mockImplementationOnce((array) => array);

        const stand = standInFor(null, "A".repeat(64), lengths);

        bytes.mockRestore();

        expect(stand).toHaveLength(64);
        expect(stand).not.toBe("A".repeat(64));
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
