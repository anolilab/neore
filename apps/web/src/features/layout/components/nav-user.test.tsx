import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasLastAccountHint, writeLastAccountHint } from "@/features/auth/lib/last-account-hint";
import { draftGeneration } from "@/features/chat/split/composer-drafts";
import { releaseThreadListWrites, writeThreadListCache } from "@/features/chat/thread-list/lib/thread-list-cache";

import NavUser from "./nav-user";

// The signed-in user (`auth.session`) is "alice".
const MINE = "neore-draft:alice:thread-a";
const THEIRS = "neore-draft:user-2:thread-a";

const auth = vi.hoisted(() => {
    const session = { data: { user: { email: "a@example.com", id: "alice", name: "Alice" } }, isPending: false };
    const signOut = vi.fn();
    const context = {
        authClient: { signOut },
        basePath: "/auth",
        mutators: { setActiveSession: vi.fn() },
        toast: vi.fn(),
        viewPaths: { SIGN_IN: "sign-in", SIGN_OUT: "sign-out", SIGN_UP: "sign-up" },
    };

    return { context, session, signOut };
});

const passthrough = vi.hoisted(() => ({ children }: { children?: ReactNode }) => <div>{children}</div>);

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { i18n: { locale: "en" }, t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@neore/ui/components/responsive-dropdown-menu", () => {
    const item = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
        <button onClick={onClick} type="button">
            {children}
        </button>
    );

    return {
        DropdownMenu: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuGroup: passthrough,
        DropdownMenuItem: item,
        DropdownMenuLabel: passthrough,
        DropdownMenuSeparator: () => null,
        DropdownMenuSub: passthrough,
        DropdownMenuSubContent: passthrough,
        DropdownMenuSubTrigger: passthrough,
        DropdownMenuTrigger: passthrough,
    };
});
vi.mock("@neore/ui/components/sidebar", () => {
    return { SidebarMenu: passthrough, SidebarMenuButton: passthrough, SidebarMenuItem: passthrough };
});
vi.mock("@tanstack/react-router", () => {
    return { Link: passthrough };
});
vi.mock("@/features/auth/components/user-view", () => {
    return { default: () => null };
});
vi.mock("@/features/auth/hooks/device-session-management", () => {
    return { useListDeviceSessions: () => auth.session };
});
vi.mock("@/features/auth/hooks/session-user-management", () => {
    return { useSession: () => auth.session };
});
vi.mock("@/features/auth/hooks/use-is-anonymous", () => {
    return {
        default: () => {
            return { isAnonymous: false };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return { useAuth: () => auth.context };
});
vi.mock("@/features/billing/hooks/use-checkout", () => {
    return {
        default: () => {
            return { isPending: false, startCheckout: vi.fn() };
        },
    };
});
vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return {
        useUserPreferences: () => {
            return { hidePersonalInfo: false };
        },
    };
});
vi.mock("@/features/notifications/hooks/use-release-push-on-sign-out", () => {
    return { useReleasePushOnSignOut: () => async () => {} };
});
vi.mock("@/functions/update-locale", () => {
    return { default: vi.fn(), isSupportedLocale: () => true };
});
vi.mock("@/lib/analytics", () => {
    return { resetAnalyticsIdentity: vi.fn() };
});
vi.mock("@/lib/intl/client", () => {
    return { DEFAULT_LOCALE: "en", deLocalizeUrl: () => undefined, dynamicActivate: vi.fn(), locales: { en: "English" }, shouldIgnorePath: () => true };
});
vi.mock("@/lib/native/bridge", () => {
    return { setNativeBadge: vi.fn() };
});

describe("NavUser sign-out", () => {
    beforeEach(() => {
        localStorage.clear();
        releaseThreadListWrites();
        writeThreadListCache("alice", {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t1", title: "Private" }] },
        });
    });

    it("clears the stored thread list even when the sign-out request fails", async () => {
        auth.signOut.mockImplementation(async ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
            fetchOptions.onError();
        });
        render(<NavUser />);
        expect(localStorage).toHaveLength(1);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        expect(localStorage).toHaveLength(0);
    });

    it("lets the list be saved again when the sign-out fails", async () => {
        auth.signOut.mockImplementation(async ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
            fetchOptions.onError();
        });
        render(<NavUser />);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        writeThreadListCache("alice", {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t1", title: "Still signed in" }] },
        });
        expect(localStorage).toHaveLength(1);
    });

    it("keeps the queued prompts and the signed-in hint when the sign-out fails, and drops them once it succeeds", async () => {
        const queueKey = "neore:prompt-queue:t1";

        writeLastAccountHint();
        sessionStorage.setItem(queueKey, "[]");
        auth.signOut.mockImplementationOnce(async ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
            fetchOptions.onError();
        });
        render(<NavUser />);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalledTimes(1);
        });
        expect(sessionStorage.getItem(queueKey)).toBe("[]");
        expect(hasLastAccountHint()).toBe(true);

        const reload = vi.fn();

        vi.stubGlobal("location", { reload });
        auth.signOut.mockImplementationOnce(async ({ fetchOptions }: { fetchOptions: { onSuccess: () => Promise<void> } }) => {
            await fetchOptions.onSuccess();
        });
        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(reload).toHaveBeenCalled();
        });
        expect(sessionStorage.getItem(queueKey)).toBeNull();
        expect(hasLastAccountHint()).toBe(false);
        vi.unstubAllGlobals();
    });

    it("keeps the unsent drafts, and their saving, when the sign-out fails", async () => {
        localStorage.setItem(MINE, "{}");

        const generation = draftGeneration();

        auth.signOut.mockImplementation(async ({ fetchOptions }: { fetchOptions: { onError: () => void } }) => {
            fetchOptions.onError();
        });
        render(<NavUser />);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        expect(localStorage.getItem(MINE)).toBe("{}");
        expect(draftGeneration()).toBe(generation);
    });

    it("drops the signed-in account's unsent drafts once the sign-out succeeded, with no composer shown, and leaves another account's", async () => {
        localStorage.setItem(MINE, "{}");
        localStorage.setItem(THEIRS, "{}");
        vi.stubGlobal("location", { reload: vi.fn() });
        auth.signOut.mockImplementation(async ({ fetchOptions }: { fetchOptions: { onSuccess: () => Promise<void> } }) => {
            await fetchOptions.onSuccess();
        });
        render(<NavUser />);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(globalThis.location.reload).toHaveBeenCalled();
        });
        vi.unstubAllGlobals();
        expect(localStorage.getItem(MINE)).toBeNull();
        expect(localStorage.getItem(THEIRS)).toBe("{}");
    });

    it("clears it before the request is made", async () => {
        let storedAtRequest = -1;

        auth.signOut.mockImplementation(async () => {
            storedAtRequest = localStorage.length;
        });
        render(<NavUser />);

        fireEvent.click(screen.getByText("Log out"));

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        expect(storedAtRequest).toBe(0);
    });
});
