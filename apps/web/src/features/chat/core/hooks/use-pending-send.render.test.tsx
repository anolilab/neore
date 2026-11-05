/**
 * The message held for after sign-in goes out once, and only for a real
 * account whose token the RPC client already carries — never as a guest.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLoginPromptStore } from "@/features/auth/stores/login-prompt-store";
import { savePendingSend } from "@/features/chat/core/utils/pending-send";

import usePendingSend, { holdForSignIn } from "./use-pending-send";

const harness = vi.hoisted(() => {
    return {
        isAuthenticated: true,
        token: null as string | null,
        user: undefined as { id: string; isAnonymous?: boolean } | undefined,
    };
});

vi.mock("@lunora/react", () => {
    return {
        useAuth: () => {
            return { token: harness.token };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraAuth: () => {
            return { isAuthenticated: harness.isAuthenticated, isLoading: false };
        },
    };
});

vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: harness.user?.isAnonymous ?? false, user: harness.user };
        },
    };
});

const jwtFor = (sub: string): string => `x.${btoa(JSON.stringify({ sub }))}.y`;

describe("usePendingSend", () => {
    beforeEach(() => {
        globalThis.history.replaceState(null, "", "/chat");
        harness.isAuthenticated = true;
        harness.token = jwtFor("member");
        harness.user = { id: "member" };
        savePendingSend("hello");
    });

    afterEach(() => {
        sessionStorage.clear();
    });

    it("sends the held message once a real account is signed in", () => {
        const send = vi.fn();
        const { rerender } = renderHook(() => usePendingSend(true, send));

        rerender();
        // A second composer mounting later finds nothing.
        renderHook(() => usePendingSend(true, send));

        expect(send).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("never sends it as a guest", () => {
        harness.user = { id: "guest", isAnonymous: true };
        harness.token = jwtFor("guest");

        const send = vi.fn();

        renderHook(() => usePendingSend(true, send));

        expect(send).not.toHaveBeenCalled();
    });

    it("waits until the RPC client carries the signed-in account's token, then sends", () => {
        // Just signed in from a guest session: the client still holds the guest's token.
        harness.token = jwtFor("guest");

        const send = vi.fn();
        const { rerender } = renderHook(() => usePendingSend(true, send));

        expect(send).not.toHaveBeenCalled();

        harness.token = jwtFor("member");
        rerender();

        expect(send).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("does nothing signed out", () => {
        harness.user = undefined;
        harness.isAuthenticated = false;
        harness.token = null;

        const send = vi.fn();

        renderHook(() => usePendingSend(true, send));

        expect(send).not.toHaveBeenCalled();
    });

    it("leaves it for the chat when the composer is on another page (the landing page)", () => {
        globalThis.history.replaceState(null, "", "/");

        const send = vi.fn();

        renderHook(() => usePendingSend(true, send));

        expect(send).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("neore:pending-send")).not.toBeNull();
    });

    it("leaves the message for a composer that takes it", () => {
        const send = vi.fn();

        renderHook(() => usePendingSend(false, send));

        expect(send).not.toHaveBeenCalled();

        renderHook(() => usePendingSend(true, send));

        expect(send).toHaveBeenCalledExactlyOnceWith("hello");
    });
});

describe("holdForSignIn", () => {
    afterEach(() => {
        sessionStorage.clear();
        useLoginPromptStore.getState().setOpen(false);
    });

    it("keeps the message for after sign-in and opens the sign-in prompt", () => {
        sessionStorage.clear();
        holdForSignIn("draft");

        expect(useLoginPromptStore.getState().isOpen).toBe(true);
        expect(JSON.parse(sessionStorage.getItem("neore:pending-send") ?? "{}")).toMatchObject({ text: "draft" });
    });
});
