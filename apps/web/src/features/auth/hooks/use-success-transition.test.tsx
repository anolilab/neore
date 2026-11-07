/**
 * `useOnSuccessTransition`: after a successful sign-in the visitor goes to the
 * redirect the form was given, then the `?redirectTo=` query, then the auth
 * context's default, and a `stayOnPage` sign-in does not move them at all.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        contextRedirectTo: "/context-default" as string,
        navigate: vi.fn(),
        refetch: vi.fn(),
        search: {} as { redirectTo?: string },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useSearch: () => harness.search,
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {},
                navigate: harness.navigate,
                onSessionChange: undefined,
                redirectTo: harness.contextRedirectTo,
            };
        },
    };
});

vi.mock("@/features/auth/hooks/session-user-management", () => {
    return {
        useSession: () => {
            return { refetch: harness.refetch };
        },
    };
});

const { default: useOnSuccessTransition } = await import("./use-success-transition");

const succeed = async (result: { current: { onSuccess: () => Promise<void> } }) => {
    await act(async () => {
        await result.current.onSuccess();
    });
};

afterEach(() => {
    harness.search = {};
    harness.contextRedirectTo = "/context-default";
    vi.clearAllMocks();
});

describe("useOnSuccessTransition", () => {
    it("sends the visitor to the redirectTo the form was given, ahead of the URL's", async () => {
        harness.search = { redirectTo: "/from-url" };
        const { result } = renderHook(() => useOnSuccessTransition({ redirectTo: "/from-form" }));

        await succeed(result);

        expect(harness.navigate).toHaveBeenCalledTimes(1);
        expect(harness.navigate).toHaveBeenCalledWith("/from-form");
    });

    it("falls back to the ?redirectTo= query when the form was given none", async () => {
        harness.search = { redirectTo: "/from-url" };
        const { result } = renderHook(() => useOnSuccessTransition({}));

        await succeed(result);

        expect(harness.navigate).toHaveBeenCalledWith("/from-url");
    });

    it("falls back to the auth context's default when there is no redirect at all", async () => {
        const { result } = renderHook(() => useOnSuccessTransition({}));

        await succeed(result);

        expect(harness.navigate).toHaveBeenCalledWith("/context-default");
    });

    it("refreshes the session but does not navigate when stayOnPage is set", async () => {
        harness.search = { redirectTo: "/from-url" };
        const { result } = renderHook(() => useOnSuccessTransition({ stayOnPage: true }));

        await succeed(result);

        expect(harness.refetch).toHaveBeenCalledTimes(1);
        expect(harness.navigate).not.toHaveBeenCalled();
    });
});
