import { describe, expect, it } from "vitest";

import { isSignedOut } from "@/lib/auth/route-guard";

import { OFFLINE_SHELL_PATH, offlineShellRootContext } from "./offline-shell";

describe("offlineShellRootContext", () => {
    it("carries no token, identity or flags, only the nonce of its own response", () => {
        expect(offlineShellRootContext("n1")).toStrictEqual({
            authStatus: "unknown",
            isAuthenticated: false,
            nonce: "n1",
            posthog: { distinctId: null, flags: {} },
            token: undefined,
        });
    });

    it("does not read as signed out, so an offline start is not sent to sign-in", () => {
        expect(isSignedOut(offlineShellRootContext(undefined))).toBe(false);
    });

    it("is the path the service worker fetches", () => {
        expect(OFFLINE_SHELL_PATH).toBe("/offline-shell");
    });
});
