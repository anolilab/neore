import { describe, expect, it } from "vitest";

import { tokenRefreshDelayMs } from "./token-refresh";

const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const jwt = (claims: Record<string, unknown>) => `${encode({ alg: "EdDSA" })}.${encode(claims)}.signature`;

// A fixed "now" in seconds, so the arithmetic below reads directly.
const NOW_S = 1_800_000_000;
const at = (seconds: number) => seconds * 1000;

describe("tokenRefreshDelayMs", () => {
    it("renews at 80% of the token's own lifetime when it was just issued", () => {
        // A 15-minute token issued now: renew after 12 minutes.
        expect(tokenRefreshDelayMs(jwt({ exp: NOW_S + 900, iat: NOW_S }), at(NOW_S))).toBe(720_000);
    });

    it("renews sooner for a token that was already aged when this page received it", () => {
        // Issued 10 minutes ago, 5 minutes left: renew within 4 minutes, not 12.
        expect(tokenRefreshDelayMs(jwt({ exp: NOW_S + 300, iat: NOW_S - 600 }), at(NOW_S))).toBe(240_000);
    });

    it("never renews sooner than 30 seconds, even for an expired or nearly expired token", () => {
        expect(tokenRefreshDelayMs(jwt({ exp: NOW_S - 60, iat: NOW_S - 960 }), at(NOW_S))).toBe(30_000);
        expect(tokenRefreshDelayMs(jwt({ exp: NOW_S + 10, iat: NOW_S }), at(NOW_S))).toBe(30_000);
    });

    it("gives up when the claims cannot say when the token expires", () => {
        expect(tokenRefreshDelayMs("not-a-jwt", at(NOW_S))).toBeUndefined();
        expect(tokenRefreshDelayMs(jwt({ exp: NOW_S, iat: NOW_S + 900 }), at(NOW_S))).toBeUndefined();
        expect(tokenRefreshDelayMs(jwt({ sub: "user" }), at(NOW_S))).toBeUndefined();
    });
});
