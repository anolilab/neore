import { describe, expect, it } from "vitest";

import { canRetry, problemOf } from "./device-problem";

describe("problemOf", () => {
    it("shows an expired code as expired, not as a retryable failure", () => {
        expect(problemOf({ error: "expired_token", error_description: "expired", status: 400, statusText: "Bad Request" })).toBe("expired");
    });

    it("reads a code nested one level down the same way", () => {
        expect(problemOf({ error: { error: "expired_token" }, status: 400 })).toBe("expired");
        expect(problemOf({ error: { error: "key_limit" }, status: 403 })).toBe("keyLimit");
    });

    it("names the key limit and an invalid code", () => {
        expect(problemOf({ error: "key_limit", status: 403 })).toBe("keyLimit");
        expect(problemOf({ error: "invalid_request", status: 400 })).toBe("invalid");
        expect(problemOf({ error: "invalid_grant", status: 400 })).toBe("invalid");
    });

    it("does not call a refused session retryable", () => {
        expect(problemOf({ error: "access_denied", status: 403 })).toBe("notAllowed");
        expect(problemOf({ error: { error: "access_denied" }, status: 403 })).toBe("notAllowed");
    });

    it("keeps everything else retryable", () => {
        expect(problemOf(null)).toBe("unavailable");
        expect(problemOf({ status: 500 })).toBe("unavailable");
        expect(problemOf({ error: 42 })).toBe("unavailable");
    });

    it("offers Try again only for an outage, never for a refused session", () => {
        expect(canRetry(problemOf({ status: 500 }))).toBe(true);
        expect(canRetry(problemOf({ error: "access_denied", status: 403 }))).toBe(false);
        expect(canRetry(problemOf({ error: "expired_token" }))).toBe(false);
    });
});
