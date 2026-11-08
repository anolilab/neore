import { describe, expect, it } from "vitest";

import { identityFromBearerClaims } from "./bearer-identity";

describe("identityFromBearerClaims", () => {
    it("gives a web JWT its session", () => {
        expect(identityFromBearerClaims({ sid: "s1", sub: "u1" })).toStrictEqual({ sessionId: "s1", userId: "u1" });
    });

    it("never gives a grant JWT a session: its sign-in is only `grantSessionId`, which the deletion guard does not read", () => {
        expect(identityFromBearerClaims({ gsid: "g1", sub: "u1" })).toStrictEqual({ grantSessionId: "g1", userId: "u1" });
    });

    it("refuses a token without a subject", () => {
        expect(identityFromBearerClaims({ sid: "s1" })).toBeNull();
    });
});
