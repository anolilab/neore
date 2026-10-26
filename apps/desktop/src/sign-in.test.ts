import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { beginSignIn, completeSignIn, isBlockedOauthUrl, parseSignInCallback, pkceChallenge, REDIRECT_URI, SIGN_IN_TTL_MS } from "./sign-in";

const ORIGIN = new URL("https://app.example.com/");

/** Characters base64url never produces. */
const BASE64URL_ONLY_EXCLUSIONS = /[+/=]/u;

const callback = (query: string) => new URL(`neore://auth/callback?${query}`);

describe("PKCE", () => {
    it("matches the RFC 7636 appendix B vector", () => {
        expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });

    it("uses base64url without padding, the same as a hash of the verifier", () => {
        const verifier = "a".repeat(43);
        const expected = createHash("sha256").update(verifier).digest("base64url");

        expect(pkceChallenge(verifier)).toBe(expected);
        expect(expected).not.toMatch(BASE64URL_ONLY_EXCLUSIONS);
    });
});

describe("beginSignIn", () => {
    it("opens the grant page with a challenge for the verifier, never the verifier itself", () => {
        const { pending, url } = beginSignIn(ORIGIN, 1000);

        expect(url.origin).toBe(ORIGIN.origin);
        expect(url.pathname).toBe("/auth/extension");
        expect(url.searchParams.get("client")).toBe("native");
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
        expect(url.searchParams.get("state")).toBe(pending.state);
        expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(pending.verifier));
        expect(pending.verifier).toHaveLength(43);
        expect(url.href).not.toContain(pending.verifier);
        expect(pending.startedAt).toBe(1000);
    });

    it("makes every flow fresh", () => {
        const a = beginSignIn(ORIGIN).pending;
        const b = beginSignIn(ORIGIN).pending;

        expect(a.state).not.toBe(b.state);
        expect(a.verifier).not.toBe(b.verifier);
    });
});

describe("parseSignInCallback", () => {
    const code = "c".repeat(43);
    const state = "s".repeat(22);

    it("reads a well-formed callback", () => {
        expect(parseSignInCallback(callback(`code=${code}&state=${state}`))).toEqual({ code, state });
    });

    it("refuses the wrong scheme, host or path, and a missing or malformed value", () => {
        const refused = (raw: string) => parseSignInCallback(new URL(raw));

        expect(refused(`https://auth/callback?code=${code}&state=${state}`)).toBeUndefined();
        expect(refused(`neore://other/callback?code=${code}&state=${state}`)).toBeUndefined();
        expect(refused(`neore://auth/other?code=${code}&state=${state}`)).toBeUndefined();
        expect(parseSignInCallback(callback(`code=${code}`))).toBeUndefined();
        expect(parseSignInCallback(callback(`code=a%20b&state=${state}`))).toBeUndefined();
        const long = "c".repeat(200);

        expect(parseSignInCallback(callback(`code=${long}&state=${state}`))).toBeUndefined();
    });
});

describe("completeSignIn", () => {
    it("hands over the verifier for the matching state", () => {
        const { pending } = beginSignIn(ORIGIN, 0);

        expect(completeSignIn(pending, "code", pending.state, 1)).toEqual({
            code: "code",
            codeVerifier: pending.verifier,
            redirectUri: REDIRECT_URI,
        });
    });

    it("refuses a foreign state, a missing flow, and an expired one", () => {
        const { pending } = beginSignIn(ORIGIN, 0);

        expect(() => completeSignIn(pending, "code", "someone-elses-state-value", 1)).toThrow("does not belong");
        expect(() => completeSignIn(pending, "code", pending.state.slice(1), 1)).toThrow("does not belong");
        expect(() => completeSignIn(undefined, "code", pending.state, 1)).toThrow("no sign-in in progress");
        expect(() => completeSignIn(pending, "code", pending.state, SIGN_IN_TTL_MS + 1)).toThrow("too long");
    });
});

describe("isBlockedOauthUrl", () => {
    it("intercepts only https Google sign-in", () => {
        expect(isBlockedOauthUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
        expect(isBlockedOauthUrl("https://accounts.google.com.example.org/")).toBe(false);
        expect(isBlockedOauthUrl("https://github.com/login/oauth/authorize")).toBe(false);
        expect(isBlockedOauthUrl("not a url")).toBe(false);
    });
});
