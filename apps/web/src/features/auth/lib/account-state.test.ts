import { describe, expect, it } from "vitest";

import { hasNoAccount } from "./account-state";

describe("hasNoAccount", () => {
    it.each([
        ["a guest", { data: { user: { isAnonymous: true } }, isPending: false }, true],
        ["an account", { data: { user: { isAnonymous: false } }, isPending: false }, false],
        ["an answered read with no user", { data: null, error: null, isPending: false }, true],
        ["a read still pending", { data: null, isPending: true }, false],
        ["a failed read", { data: null, error: new Error("429"), isPending: false }, false],
    ] as const)("%s → %s", (_label, read, expected) => {
        expect(hasNoAccount(read)).toBe(expected);
    });
});
