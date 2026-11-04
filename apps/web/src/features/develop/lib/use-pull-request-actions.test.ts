import { describe, expect, it } from "vitest";

import { isPreHostRefusal } from "./use-pull-request-actions";

describe("isPreHostRefusal", () => {
    it.each(["BAD_REQUEST", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"])("treats %s as thrown before any host call", (code) => {
        expect(isPreHostRefusal({ code })).toBe(true);
    });

    it("reads the code under data, where the client puts a server error's code", () => {
        expect(isPreHostRefusal({ data: { code: "TOO_MANY_REQUESTS" } })).toBe(true);
        expect(isPreHostRefusal({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    });

    it("does not treat a server failure as a refusal: the host may have acted before it failed", () => {
        expect(isPreHostRefusal({ code: "INTERNAL_SERVER_ERROR" })).toBe(false);
    });

    it("does not treat an error without a code as a refusal", () => {
        expect(isPreHostRefusal(new Error("connection lost"))).toBe(false);
        expect(isPreHostRefusal(undefined)).toBe(false);
    });
});
