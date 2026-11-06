import { describe, expect, it } from "vitest";

import { tokenSubject } from "./use-pending-send";

const jwt = (payload: { sub: unknown }): string => `x.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.y`;

describe("tokenSubject", () => {
    it("reads the subject of a JWT", () => {
        expect(tokenSubject(jwt({ sub: "user-1" }))).toBe("user-1");
    });

    it.each([null, undefined, "", "not-a-jwt", "x.%%%.y", jwt({ sub: 42 })])("returns nothing for %o", (token) => {
        expect(tokenSubject(token)).toBeUndefined();
    });
});
