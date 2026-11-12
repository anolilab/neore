/**
 * `<UnauthenticatedGate>`: a guest session only while registration is open;
 * under invite-only the signed-out page, and nothing either way until the
 * backend has said which.
 */
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionContext } from "@/features/connection/hooks/use-connection";

import UnauthenticatedGate from "./unauthenticated-gate";

const harness = vi.hoisted(() => {
    return {
        adopt: vi.fn(async () => undefined),
        /** Settles the pending re-read; set by the `rereadFailedSession` mock. */
        finishReread: undefined as (() => void) | undefined,
        reread: vi.fn(
            async () =>
                await new Promise<void>((resolve: (value: PromiseLike<void> | void) => void) => {
                    harness.finishReread = resolve;
                }),
        ),
        inviteOnly: undefined as boolean | undefined,
        session: { data: null as { user: { id: string } } | null, error: null as unknown, isPending: false },
    };
});

vi.mock("@/features/auth/hooks/use-sign-in-methods", () => {
    return {
        default: () => {
            return { inviteOnly: harness.inviteOnly };
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { hooks: { useSession: () => harness.session } };
        },
    };
});

vi.mock("@/features/auth/components/auto-guest-signin", () => {
    return { default: () => <p>guest sign-in</p> };
});

vi.mock("@/features/auth/lib/guest-session", () => {
    return { adoptSessionTokenWhileShut: harness.adopt };
});

vi.mock("@/lib/auth/client", () => {
    return { rereadFailedSession: harness.reread };
});

vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn() };
});

vi.mock("@/lib/lunora/crpc", () => {
    return { useLunora: () => harness };
});

const gate = () => <UnauthenticatedGate loading={<p>loading</p>} signedOut={<p>signed out</p>} />;

const OFFLINE = { backOnline: false, banner: "offline", screen: "offline", view: "offline" } as const;
const RECONNECTING = { backOnline: false, banner: "reconnecting", screen: null, view: "reconnecting" } as const;
const ONLINE = { backOnline: false, banner: "online", screen: null, view: "online" } as const;

describe("UnauthenticatedGate", () => {
    beforeEach(() => {
        harness.inviteOnly = undefined;
        harness.session = { data: null, error: null, isPending: false };
        harness.adopt.mockClear();
        harness.reread.mockClear();
        harness.finishReread = undefined;
    });

    it("waits, and makes no guest, until the backend says whether registration is invite-only", () => {
        render(gate());

        expect(screen.getByText("loading")).toBeTruthy();
        expect(screen.queryByText("guest sign-in")).toBeNull();
    });

    it("makes a guest session when registration is open", () => {
        harness.inviteOnly = false;

        render(gate());

        expect(screen.getByText("guest sign-in")).toBeTruthy();
    });

    it("shows the signed-out page under invite-only, with no guest sign-in", () => {
        harness.inviteOnly = true;

        render(gate());

        expect(screen.getByText("signed out")).toBeTruthy();
        expect(screen.queryByText("guest sign-in")).toBeNull();
    });

    it("hands an existing session's token to the client instead of showing the signed-out page", () => {
        harness.inviteOnly = true;
        harness.session = { data: { user: { id: "user-1" } }, error: null, isPending: false };

        render(gate());

        expect(screen.getByText("loading")).toBeTruthy();
        expect(screen.queryByText("signed out")).toBeNull();
        expect(harness.adopt).toHaveBeenCalledTimes(1);
    });

    it("does not read a pending session read as signed out", () => {
        harness.inviteOnly = true;
        harness.session = { data: null, error: null, isPending: true };

        render(gate());

        expect(screen.getByText("loading")).toBeTruthy();
    });

    it("shows the signed-out page, not loading forever, when the session read failed with no session", () => {
        harness.inviteOnly = true;
        harness.session = { data: undefined as never, error: new Error("429"), isPending: false };

        render(gate());

        expect(screen.getByText("signed out")).toBeTruthy();
    });

    it("never shows the signed-out page (and its sign-in redirect) for a session read that failed offline", () => {
        harness.inviteOnly = true;
        harness.session = { data: null, error: { status: 503 }, isPending: false };

        render(<ConnectionContext value={OFFLINE}>{gate()}</ConnectionContext>);

        expect(screen.getByText("loading")).toBeTruthy();
        expect(screen.queryByText("signed out")).toBeNull();
    });

    it("makes no guest session for a read that failed offline, even with registration open", () => {
        harness.inviteOnly = false;
        harness.session = { data: null, error: { status: 503 }, isPending: false };

        render(<ConnectionContext value={OFFLINE}>{gate()}</ConnectionContext>);

        expect(screen.getByText("loading")).toBeTruthy();
        expect(screen.queryByText("guest sign-in")).toBeNull();
    });

    it("still shows the signed-out page offline when the server had answered there is no session", () => {
        harness.inviteOnly = true;

        render(<ConnectionContext value={OFFLINE}>{gate()}</ConnectionContext>);

        expect(screen.getByText("signed out")).toBeTruthy();
    });

    it("after a server outage, stays loading until the failed session read has been re-read, then shows the session", async () => {
        harness.inviteOnly = true;
        harness.session = { data: null, error: { status: 503 }, isPending: false };

        const { rerender } = render(<ConnectionContext value={RECONNECTING}>{gate()}</ConnectionContext>);

        expect(harness.reread).not.toHaveBeenCalled();

        rerender(<ConnectionContext value={ONLINE}>{gate()}</ConnectionContext>);

        expect(screen.getByText("loading")).toBeTruthy();
        expect(screen.queryByText("signed out")).toBeNull();
        expect(harness.reread).toHaveBeenCalledOnce();

        harness.session = { data: { user: { id: "user-1" } }, error: null, isPending: false };
        await act(async () => {
            harness.finishReread?.();
        });

        expect(screen.queryByText("signed out")).toBeNull();
        expect(harness.adopt).toHaveBeenCalledOnce();
    });

    it("shows the signed-out page once the re-read after the outage still fails", async () => {
        harness.inviteOnly = true;
        harness.session = { data: null, error: { status: 503 }, isPending: false };

        const { rerender } = render(<ConnectionContext value={OFFLINE}>{gate()}</ConnectionContext>);

        rerender(<ConnectionContext value={ONLINE}>{gate()}</ConnectionContext>);

        expect(screen.getByText("loading")).toBeTruthy();

        await act(async () => {
            harness.finishReread?.();
        });

        expect(screen.getByText("signed out")).toBeTruthy();
    });
});
