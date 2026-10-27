import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { isSignedOut, requireSession } from "./route-guard";

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

describe("requireSession on a context without authStatus", () => {
    it("falls back to isAuthenticated, redirecting only when it is not set", () => {
        expect(redirectOf({ isAuthenticated: false }, { href: "/dashboard", pathname: "/dashboard" })).toMatchObject({ to: "/auth/sign-in" });
        expect(redirectOf({}, { href: "/dashboard", pathname: "/dashboard" })).toMatchObject({ to: "/auth/sign-in" });
        expect(redirectOf({ isAuthenticated: true }, { href: "/dashboard", pathname: "/dashboard" })).toBeUndefined();
    });

    it("lets authStatus win over a contradicting isAuthenticated", () => {
        // A failed token fetch leaves `isAuthenticated` false while the status is "unknown".
        expect(redirectOf({ authStatus: "unknown", isAuthenticated: false }, { href: "/chat", pathname: "/chat" })).toBeUndefined();
        expect(redirectOf({ authStatus: "unauthenticated", isAuthenticated: true }, { href: "/chat", pathname: "/chat" })).toMatchObject({
            to: "/auth/sign-in",
        });
    });
});

describe("isSignedOut", () => {
    it("is true only for an answered no-session", () => {
        expect(isSignedOut({ authStatus: "unauthenticated" })).toBe(true);
        expect(isSignedOut({ authStatus: "authenticated" })).toBe(false);
        expect(isSignedOut({ authStatus: "unknown" })).toBe(false);
    });
});
