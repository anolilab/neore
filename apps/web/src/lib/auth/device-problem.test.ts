import { describe, expect, it } from "vitest";

import { problemOf } from "./device-problem";

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

    it("keeps everything else retryable", () => {
        expect(problemOf(null)).toBe("unavailable");
        expect(problemOf({ status: 500 })).toBe("unavailable");
        expect(problemOf({ error: "access_denied" })).toBe("unavailable");
        expect(problemOf({ error: 42 })).toBe("unavailable");
    });
});
