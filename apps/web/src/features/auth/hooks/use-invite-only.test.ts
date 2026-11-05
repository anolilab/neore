import { describe, expect, it } from "vitest";

import { mustSignInToChat, signUpHrefFor } from "./use-invite-only";

describe("mustSignInToChat", () => {
    it.each([
        ["signed out, invite-only", true, null, true],
        ["a guest, invite-only", true, { isAnonymous: true }, true],
        ["an account, invite-only", true, { isAnonymous: false }, false],
        ["signed out, not yet known", undefined, null, true],
        ["a guest, registration open", false, { isAnonymous: true }, false],
        ["signed out, registration open", false, null, false],
    ] as const)("%s → %s", (_label, inviteOnly, user, expected) => {
        expect(mustSignInToChat(inviteOnly, user)).toBe(expected);
    });
});

describe("signUpHrefFor", () => {
    it("keeps the invitation token, so the sign-up form can redeem it", () => {
        expect(signUpHrefFor(true, "a b+c")).toBe("/auth/sign-up?invite=a%20b%2Bc");
    });

    it("links to sign-up without a token when registration is open", () => {
        expect(signUpHrefFor(true, undefined)).toBe("/auth/sign-up");
    });

    it("links to sign-in when sign-up is not offered", () => {
        expect(signUpHrefFor(false, undefined)).toBe("/auth/sign-in");
    });
});
