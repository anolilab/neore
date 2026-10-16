import { describe, expect, it } from "vitest";

import { tokenRefreshDelayMs } from "./token-refresh";

const jwt = (claims: Record<string, unknown>) => {
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

    return `${encode({ alg: "EdDSA" })}.${encode(claims)}.signature`;
};

describe("tokenRefreshDelayMs", () => {
    it("renews at 80% of the token's own lifetime", () => {
        // A 15-minute token: renew after 12 minutes.
        expect(tokenRefreshDelayMs(jwt({ iat: 1000, exp: 1900 }))).toBe(720_000);
    });

    it("never renews sooner than 30 seconds for a very short token", () => {
        expect(tokenRefreshDelayMs(jwt({ iat: 1000, exp: 1010 }))).toBe(30_000);
    });

    it("gives up when the claims cannot say when the token expires", () => {
        expect(tokenRefreshDelayMs("not-a-jwt")).toBeUndefined();
        expect(tokenRefreshDelayMs(jwt({ iat: 1900, exp: 1000 }))).toBeUndefined();
        expect(tokenRefreshDelayMs(jwt({ sub: "user" }))).toBeUndefined();
    });
});
