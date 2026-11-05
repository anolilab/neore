import { describe, expect, it } from "vitest";

import { mustSignInToChat } from "./use-invite-only";

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
