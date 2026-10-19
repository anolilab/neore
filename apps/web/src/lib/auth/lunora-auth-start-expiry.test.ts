import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cacheExpiryFor } from "./lunora-auth-start";

const jwt = (payload: Record<string, unknown>) => `header.${btoa(JSON.stringify(payload))}.signature`;

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
