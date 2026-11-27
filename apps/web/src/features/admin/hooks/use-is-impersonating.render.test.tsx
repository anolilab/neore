/**
 * `useImpersonating()`: the controls an impersonated session is refused stay withheld until the session says it is
 * not one, so an admin acting as someone never sees Delete in the gap before that is known.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => {
    return { current: {} as { data?: { session?: { impersonatedBy?: string | null } }; error?: Error | null; isPending?: boolean } };
});

vi.mock("@/features/auth/hooks/use-auth-session", () => {
    return { useAuthSession: () => session.current };
});

const { useImpersonating } = await import("./use-is-impersonating");

describe(useImpersonating, () => {
    beforeEach(() => {
        session.current = {};
    });

    it("withholds while the session is still being read", () => {
        session.current = { data: undefined, error: null, isPending: true };

        expect(renderHook(() => useImpersonating()).result.current).toBe(true);
    });

    it("withholds when the session read failed", () => {
        session.current = { data: undefined, error: new Error("429"), isPending: false };

        expect(renderHook(() => useImpersonating()).result.current).toBe(true);
    });

    it("withholds for a session an admin is impersonating with", () => {
        session.current = { data: { session: { impersonatedBy: "admin-1" } }, error: null, isPending: false };

        expect(renderHook(() => useImpersonating()).result.current).toBe(true);
    });

    it.each([null, undefined])("offers the controls to the account's own session (impersonatedBy %s)", (impersonatedBy) => {
        session.current = { data: { session: { impersonatedBy } }, error: null, isPending: false };

        expect(renderHook(() => useImpersonating()).result.current).toBe(false);
    });
});
