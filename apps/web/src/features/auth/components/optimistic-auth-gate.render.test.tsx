/**
 * The chat layout's auth gate (`routes/(chat)/route.tsx` + `OptimisticAuthGate`): the signed-in layout paints
 * while Lunora's identity probe is out when the session is known (the SSR `authStatus`, or the stored
 * last-account hint), and the skeleton only when nothing says who is here.
 *
 * Lunora's gates are modelled on `@lunora/react`'s: one status, "loading" until the probe answers.
 */
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest runs without globals, so nothing else cleans up between tests
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server.browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Route } from "@/routes/(chat)/route";

import { clearLastAccountHint, hasLastAccountHint, writeLastAccountHint } from "../lib/last-account-hint";

type Status = "authenticated" | "loading" | "unauthenticated";

const harness = vi.hoisted(() => {
    const listeners = new Set<() => void>();

    return {
        authStatus: "unknown" as "authenticated" | "unauthenticated" | "unknown",
        listeners,
        status: "loading" as Status,
    };
});

const setLunoraStatus = (status: Status) => {
    harness.status = status;

    for (const listener of harness.listeners) {
        listener();
    }
};

vi.mock("@lunora/react", async () => {
    const { useSyncExternalStore } = await import("react");

    const useAuthState = () => {
        const status = useSyncExternalStore(
            (listener: () => void) => {
                harness.listeners.add(listener);

                return () => harness.listeners.delete(listener);
            },
            () => harness.status,
            // As upstream: the server and the hydration render read "loading".
            () => "loading" as Status,
        );

        return { isAuthenticated: status === "authenticated", isLoading: status === "loading" };
    };

    return {
        Authenticated: ({ children }: { children: ReactNode }) => (useAuthState().isAuthenticated ? children : null),
        AuthLoading: ({ children }: { children: ReactNode }) => (useAuthState().isLoading ? children : null),
        Unauthenticated: ({ children }: { children: ReactNode }) => {
            const { isAuthenticated, isLoading } = useAuthState();

            return !isLoading && !isAuthenticated ? children : null;
        },
        useAuthState,
    };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@tanstack/react-router")>();

    return {
        ...actual,
        Outlet: () => <p>thread list and thread</p>,
        useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) => select({ pathname: "/" }),
        useRouteContext: ({ select }: { select?: (context: { authStatus: string }) => unknown }) => {
            const context = { authStatus: harness.authStatus };

            return select ? select(context) : context;
        },
    };
});

vi.mock("@neore/backend/api", () => {
    return { api: {} };
});
vi.mock("@/components/command-palette", () => {
    return { default: () => null };
});
vi.mock("@/components/model-picker", () => {
    return { ModelPickerPopup: () => null };
});
vi.mock("@/components/programmable-sidebar-provider", () => {
    return { default: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@/features/auth/components/sign-in-redirect", () => {
    return { default: () => <p>redirecting to sign in</p> };
});
vi.mock("@/features/auth/components/unauthenticated-gate", () => {
    return { default: ({ signedOut }: { signedOut: ReactNode }) => signedOut };
});
vi.mock("@/features/chat/loading/chat-loading-skeleton", () => {
    return { default: () => <p>loading skeleton</p> };
});
vi.mock("@/features/chat/signed-out/signed-out-chat", () => {
    return { default: () => null };
});
vi.mock("@/features/chat/signed-out/signed-out-view", () => {
    return { signedOutViewFor: () => "sign-in" };
});
vi.mock("@/features/keyboard/components/keyboard-shortcuts-manager", () => {
    return { KeyboardShortcutsManager: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@/features/keyboard/hooks/use-keyboard-shortcut-handler", () => {
    return { default: () => () => undefined };
});
vi.mock("@/features/onboarding/components/onboarding-dialog", () => {
    return { default: () => null };
});
vi.mock("@/features/slides", () => {
    return { PresentationViewerRoot: () => null };
});
vi.mock("@/lib/lunora/crpc", () => {
    return { createLunoraQueryOptions: vi.fn() };
});

const ChatLayout = Route.options.component as () => ReactNode;

describe("the chat layout's auth gate", () => {
    beforeEach(() => {
        harness.authStatus = "unknown";
        harness.status = "loading";
        clearLastAccountHint();
    });

    afterEach(() => {
        cleanup();
        clearLastAccountHint();
    });

    it("renders the signed-in layout on the server for a request the server knows is signed in, and hydrates without a mismatch", async () => {
        harness.authStatus = "authenticated";

        // Streamed and awaited whole, as TanStack Start's SSR does (the lazy onboarding dialog suspends).
        const view = await renderToReadableStream(<ChatLayout />);

        await view.allReady;

        const html = await new Response(view).text();

        expect(html).toContain("thread list and thread");
        expect(html).not.toContain("loading skeleton");

        const host = document.createElement("div");
        const recoverable = vi.fn();

        host.innerHTML = html;
        document.body.appendChild(host);

        // The hydration render reads Lunora's server snapshot ("loading") and the dehydrated `authStatus`.
        const root = await act(async () => hydrateRoot(host, <ChatLayout />, { onRecoverableError: recoverable }));

        expect(recoverable).not.toHaveBeenCalled();
        expect(host.textContent).toContain("thread list and thread");

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it("renders the signed-in layout on the client while Lunora loads, when the last account is remembered", () => {
        writeLastAccountHint("user-1");

        render(<ChatLayout />);

        expect(screen.getByText("thread list and thread")).toBeTruthy();
        expect(screen.queryByText("loading skeleton")).toBeNull();
    });

    it("hands over to the signed-out path when Lunora answers that there is no session", () => {
        harness.authStatus = "authenticated";
        writeLastAccountHint("user-1");

        render(<ChatLayout />);

        expect(screen.getByText("thread list and thread")).toBeTruthy();

        act(() => {
            setLunoraStatus("unauthenticated");
        });

        expect(screen.queryByText("thread list and thread")).toBeNull();
        expect(screen.getByText("redirecting to sign in")).toBeTruthy();
    });

    it("keeps the layout mounted when Lunora confirms the session", () => {
        harness.authStatus = "authenticated";

        render(<ChatLayout />);

        const painted = screen.getByText("thread list and thread");

        act(() => {
            setLunoraStatus("authenticated");
        });

        expect(screen.getByText("thread list and thread")).toBe(painted);
    });

    it("shows the skeleton when there is neither a token nor a remembered account", () => {
        render(<ChatLayout />);

        expect(screen.getByText("loading skeleton")).toBeTruthy();
        expect(screen.queryByText("thread list and thread")).toBeNull();
    });

    it("ignores a remembered account once the server has answered that there is no session", () => {
        harness.authStatus = "unauthenticated";
        writeLastAccountHint("user-1");

        render(<ChatLayout />);

        expect(screen.getByText("loading skeleton")).toBeTruthy();
        expect(hasLastAccountHint()).toBe(true);
    });
});
