import { describe, expect, it } from "vitest";

import { buildAuthorizeUrl, createPkcePair, parseAuthorizeResponse, SignInError } from "./extension-grant";

const REDIRECT_URI = `https://${"ab".repeat(20)}.extensions.allizom.org/`;

describe("createPkcePair", () => {
    it("makes a 43-character verifier and its S256 challenge", async () => {
        const { challenge, verifier } = await createPkcePair();
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
        const expected = btoa(String.fromCodePoint(...digest))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");

        expect(verifier).toMatch(/^[\w-]{43}$/);
        expect(challenge).toBe(expected);
        // Unpadded base64url: a SHA-256 digest is 43 characters without the trailing `=`.
        expect(challenge).toMatch(/^[\w-]{43}$/);
    });

    it("is random per call", async () => {
        const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);

        expect(a.verifier).not.toBe(b.verifier);
    });
});

describe("buildAuthorizeUrl", () => {
    it("points at the app page and carries the challenge — never the verifier", () => {
        const url = new URL(
            buildAuthorizeUrl({ appUrl: "https://app.example.test/some/path", challenge: "c".repeat(43), redirectUri: REDIRECT_URI, state: "s1" }),
        );

        expect(url.origin + url.pathname).toBe("https://app.example.test/auth/extension");
        expect(Object.fromEntries(url.searchParams)).toEqual({ code_challenge: "c".repeat(43), redirect_uri: REDIRECT_URI, state: "s1" });
    });
});

describe("parseAuthorizeResponse", () => {
    const parse = (url: string | undefined) => parseAuthorizeResponse(url, { redirectUri: REDIRECT_URI, state: "s1" });

    it("returns the code", () => {
        expect(parse(`${REDIRECT_URI}?code=abc&state=s1`)).toBe("abc");
    });

    it("rejects a state that does not round-trip", () => {
        expect(() => parse(`${REDIRECT_URI}?code=abc&state=other`)).toThrow(SignInError);
        expect(() => parse(`${REDIRECT_URI}?code=abc`)).toThrow(SignInError);
    });

    it("rejects a response from anywhere but the redirect URI", () => {
        expect(() => parse("https://evil.example/?code=abc&state=s1")).toThrow(/unexpected address/);
        expect(() => parse(`${REDIRECT_URI}elsewhere?code=abc&state=s1`)).toThrow(/unexpected address/);
    });

    it("reports cancellation, errors and a missing code", () => {
        expect(() => parse(undefined)).toThrow(/cancelled/);
        expect(() => parse(`${REDIRECT_URI}?error=access_denied&state=s1`)).toThrow(/declined/);
        expect(() => parse(`${REDIRECT_URI}?state=s1`)).toThrow(/did not return a code/);
    });
});
