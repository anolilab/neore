// @vitest-environment jsdom

/**
 * Files dropped on the dock icon: the listener stays subscribed while the session resolves (a re-subscribe mid-drain
 * lost the drop), and a drop carries the account known when it arrives.
 */
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => {
    return {
        accountsAtStart: [] as (() => string | undefined)[],
        discards: [] as ((count: number) => void)[],
        fileListeners: [] as ((files: File[], accountId: string | undefined) => void)[],
        unsubscribed: 0,
    };
});
const session = vi.hoisted(() => {
    return { data: null as { user: { id: string } } | null, isPending: true };
});
const requestComposerAttach = vi.hoisted(() => vi.fn());
// Stable across renders, as the router's own `navigate` and `router` are.
const router = vi.hoisted(() => {
    return { navigate: async () => {}, router: { state: { location: { pathname: "/chat" } } } };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings.join("") };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => router.navigate,
        useRouter: () => router.router,
    };
});

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => {
    return { toast: { error: toastError, success: () => {} } };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {
                    useSession: () => {
                        return { data: session.data, isPending: session.isPending };
                    },
                },
            };
        },
    };
});

vi.mock("@/features/layout/stores/ui-state-store", () => {
    return {
        useUIStateStore: {
            getState: () => {
                return { openModal: () => {} };
            },
        },
    };
});

vi.mock("@/hooks/use-after-first-paint", () => {
    return { default: () => false };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: () => {} };
});

vi.mock("./device-bridge", () => {
    return { getNativeDeviceStatus: async () => undefined };
});

vi.mock("./shell-inbox", () => {
    const none = () => () => {};

    return {
        completeNativeSignIn: async () => {},
        onNativeCompose: none,
        onNativeDraft: none,
        onNativeFiles: (
            listener: (files: File[], accountId: string | undefined) => void,
            accountAtStart: () => string | undefined,
            onDiscarded: (count: number) => void,
        ) => {
            inbox.fileListeners.push(listener);
            inbox.accountsAtStart.push(accountAtStart);
            inbox.discards.push(onDiscarded);

            return () => {
                inbox.unsubscribed += 1;
            };
        },
        onNativeMenuCommand: none,
        onNativeSignIn: none,
    };
});

vi.mock("@/features/chat/core/utils/composer-submit", () => {
    return { requestComposerAttach };
});

const { default: NativeBridge } = await import("./native-bridge");

describe("NativeBridge dock drops", () => {
    it("keeps one listener while the session resolves, and tags a later drop with the account", async () => {
        const { rerender } = render(<NativeBridge />);

        session.data = { user: { id: "u1" } };
        session.isPending = false;
        rerender(<NativeBridge />);

        expect(inbox.fileListeners).toHaveLength(1);
        expect(inbox.unsubscribed).toBe(0);

        // The shell hands a drop over under u1, the account still signed in when it is queued.
        const startedFor = inbox.accountsAtStart[0]?.();
        const file = new File(["a"], "a.txt");

        inbox.fileListeners[0]?.([file], startedFor);

        await waitFor(() => {
            expect(requestComposerAttach).toHaveBeenCalledWith({ accountId: "u1", files: [file] });
        });
    });

    it("does not queue a dock drop whose account changed while the composer code loaded, and says so", async () => {
        requestComposerAttach.mockClear();
        toastError.mockClear();
        session.data = { user: { id: "u2" } };
        session.isPending = false;
        render(<NativeBridge />);
        // Taken from the shell under u1; by the time it is queued, u2 is signed in.
        inbox.fileListeners.at(-1)?.([new File(["a"], "a.txt")], "u1");

        await waitFor(() => {
            expect(toastError).toHaveBeenCalledTimes(1);
        });
        expect(requestComposerAttach).not.toHaveBeenCalled();
    });

    it("tells the person when a dock drop replaced an earlier drop for another account", async () => {
        requestComposerAttach.mockReturnValueOnce(1);
        toastError.mockClear();
        render(<NativeBridge />);
        inbox.fileListeners.at(-1)?.([new File(["a"], "a.txt")], "u2");

        await waitFor(() => {
            expect(toastError).toHaveBeenCalledTimes(1);
        });
    });

    it("tells the person when a dock drop was let go across an account switch", () => {
        render(<NativeBridge />);
        inbox.discards.at(-1)?.(2);

        expect(toastError).toHaveBeenCalledTimes(1);
    });

    it("marks a drop made with no one signed in as signed out, not as any account", () => {
        session.data = null;
        session.isPending = false;
        render(<NativeBridge />);

        expect(inbox.accountsAtStart.at(-1)?.()).toBe("signed-out");
    });
});
