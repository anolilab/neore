// @vitest-environment jsdom

/**
 * Files dropped on the dock icon: the listener stays subscribed while the session resolves (a re-subscribe mid-drain
 * lost the drop), and a drop carries the account known when it arrives.
 */
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const inbox = vi.hoisted(() => {
    return { fileListeners: [] as ((files: File[]) => void)[], unsubscribed: 0 };
});
const session = vi.hoisted(() => {
    return { data: null as { user: { id: string } } | null };
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

vi.mock("sonner", () => {
    return { toast: { error: () => {}, success: () => {} } };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {
                    useSession: () => {
                        return { data: session.data };
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
        onNativeFiles: (listener: (files: File[]) => void) => {
            inbox.fileListeners.push(listener);

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
        rerender(<NativeBridge />);

        expect(inbox.fileListeners).toHaveLength(1);
        expect(inbox.unsubscribed).toBe(0);

        const file = new File(["a"], "a.txt");

        inbox.fileListeners[0]?.([file]);

        await waitFor(() => {
            expect(requestComposerAttach).toHaveBeenCalledWith({ accountId: "u1", files: [file] });
        });
    });
});
