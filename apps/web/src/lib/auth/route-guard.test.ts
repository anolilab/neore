import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { requireSession } from "./route-guard";

type RedirectOptions = { search?: Record<string, unknown>; to: string };

/** The redirect `requireSession` throws, or `undefined` when it lets the route render. */
const redirectOf = (...arguments_: Parameters<typeof requireSession>): RedirectOptions | undefined => {
    try {
        requireSession(...arguments_);
    } catch (error) {
        return isRedirect(error) ? (error as { options: RedirectOptions }).options : undefined;
    }

    return undefined;
};

describe("requireSession", () => {
    it("sends a signed-out visitor to sign-in with the destination", () => {
        expect(redirectOf({ authStatus: "unauthenticated" }, { href: "/invite/abc?x=1", pathname: "/invite/abc" })).toMatchObject({
            search: { redirectTo: "/invite/abc?x=1" },
            to: "/auth/sign-in",
        });
    });

    it("does not carry an auth page as the destination, which would loop", () => {
        expect(redirectOf({ authStatus: "unauthenticated" }, { href: "/auth/sign-in", pathname: "/auth/sign-in" })).toMatchObject({
            search: {},
            to: "/auth/sign-in",
        });
    });

    it("lets a signed-in visitor through, and a failed read is not a sign-out", () => {
        expect(redirectOf({ authStatus: "authenticated" }, { href: "/dashboard", pathname: "/dashboard" })).toBeUndefined();
        expect(redirectOf({ authStatus: "unknown" }, { href: "/dashboard", pathname: "/dashboard" })).toBeUndefined();
    });
});
