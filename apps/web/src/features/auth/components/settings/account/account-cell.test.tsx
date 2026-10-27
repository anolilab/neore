import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readThreadListCache, writeThreadListCache } from "@/features/chat/thread-list/lib/thread-list-cache";

import AccountCell from "./account-cell";

const auth = vi.hoisted(() => {
    return { revoke: vi.fn() };
});

const passthrough = vi.hoisted(() => ({ children }: { children?: ReactNode }) => <div>{children}</div>);

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});
vi.mock("@neore/ui/components/responsive-dropdown-menu", () => {
    return {
        DropdownMenu: passthrough,
        DropdownMenuContent: passthrough,
        DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
            <button onClick={onClick} type="button">
                {children}
            </button>
        ),
        DropdownMenuTrigger: () => null,
    };
});
vi.mock("@/features/auth/hooks/session-user-management", () => {
    return {
        useSession: () => {
            return { data: { session: { id: "current" } } };
        },
    };
});
vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: {},
                basePath: "/auth",
                mutators: { revokeDeviceSession: auth.revoke, setActiveSession: vi.fn() },
                navigate: vi.fn(),
                toast: vi.fn(),
                viewPaths: { SIGN_OUT: "sign-out" },
            };
        },
    };
});
vi.mock("../../user-view", () => {
    return { default: () => null };
});

const deviceSession = { session: { id: "other", token: "tok" }, user: { id: "bob" } } as never;

describe("AccountCell revoke", () => {
    beforeEach(() => {
        localStorage.clear();

        const list = {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t1", title: "Bob" }] },
        };

        writeThreadListCache("bob", list);
        writeThreadListCache("alice", list);
    });

    it.each(["resolves", "rejects"] as const)("clears the revoked account's stored list when the request %s", async (outcome) => {
        auth.revoke.mockImplementation(async () => {
            if (outcome === "rejects") {
                throw new Error("nope");
            }
        });
        render(<AccountCell deviceSession={deviceSession} />);

        fireEvent.click(screen.getByText("Revoke"));

        await vi.waitFor(() => {
            expect(readThreadListCache("bob")).toBeUndefined();
        });
        expect(readThreadListCache("alice")).toBeDefined();
    });
});
