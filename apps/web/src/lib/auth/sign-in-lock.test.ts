import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheExpiryFor } from "./lunora-auth-start";
import { isCredentialRequest, signInInFlight, trackCredentialRequest, waitForCredentialRequests } from "./sign-in-lock";

const jwt = (payload: Record<string, unknown>) => `header.${btoa(JSON.stringify(payload))}.signature`;

describe("isCredentialRequest", () => {
    it("matches the paths that change who the caller is", () => {
        expect(isCredentialRequest("http://localhost/api/auth/sign-in/email")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/sign-in/anonymous")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/callback/google?code=1")).toBe(true);
        expect(isCredentialRequest("http://localhost/api/auth/two-factor/verify-totp")).toBe(true);
    });

    it("ignores reads and sign-out", () => {
        expect(isCredentialRequest("http://localhost/api/auth/get-session")).toBe(false);
        expect(isCredentialRequest("http://localhost/api/auth/token")).toBe(false);
        expect(isCredentialRequest("http://localhost/api/auth/sign-out")).toBe(false);
    });
});

describe("credential request tracking", () => {
    it("holds waiters until the request settles", async () => {
        // Held on an object rather than a bare `let`: a placeholder initializer
        // takes no arguments, so a static analyser reads `resolve("ok")` below as
        // passing one argument too many.
        const gate: { resolve: (value: string) => void } = { resolve: () => {} };
        const tracked = trackCredentialRequest(
            new Promise<string>((resolve) => {
                gate.resolve = resolve;
            }),
        );

        expect(signInInFlight()).toBe(true);

        let isReleased = false;

        const waiter = (async () => {
            await waitForCredentialRequests();

            isReleased = true;
        })();

        await Promise.resolve();
        expect(isReleased).toBe(false);

        gate.resolve("ok");
        await tracked;
        await waiter;

        expect(isReleased).toBe(true);
        expect(signInInFlight()).toBe(false);
    });

    it("releases when the request fails", async () => {
        const tracked = trackCredentialRequest(Promise.reject(new Error("offline")));

        await expect(tracked).rejects.toThrow("offline");
        expect(signInInFlight()).toBe(false);
    });
});

describe("cacheExpiryFor", () => {
    // Pin the clock. Every expectation here is an exact second, and reading a
    // real `Date.now()` twice — once to build the token, once to compute the
    // expected value — is off by one whenever the second happens to roll between
    // them. That is a test that fails a few times a day for no reason.
    const NOW_SECONDS = 1_700_000_000;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_SECONDS * 1000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("expires EARLY, never after the token itself", () => {
        // Ten minutes out with a 60s tolerance, capped by the 60s max age.
        expect(cacheExpiryFor(jwt({ exp: NOW_SECONDS + 600 }), 60)).toBe(NOW_SECONDS + 60);
        // Short-lived token: the tolerance, not the cap, decides.
        expect(cacheExpiryFor(jwt({ exp: NOW_SECONDS + 90 }), 60)).toBe(NOW_SECONDS + 30);
    });

    it("refuses to cache a token it cannot date", () => {
        expect(cacheExpiryFor(jwt({}), 60)).toBe(0);
        expect(cacheExpiryFor("not-a-jwt", 60)).toBe(0);
    });

    it("refuses to cache an already-expired token", () => {
        // Asserted exactly, not as "somewhere in the past". This number is what
        // `rememberToken` compares against `now` to decide whether to store the
        // token at all, so a loose bound would pass on a wrong value that still
        // happened to be negative.
        expect(cacheExpiryFor(jwt({ exp: NOW_SECONDS - 1 }), 60)).toBe(NOW_SECONDS - 61);
    });
});
