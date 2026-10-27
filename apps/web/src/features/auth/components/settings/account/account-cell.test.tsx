import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readThreadListCache, releaseThreadListWrites, writeThreadListCache } from "@/features/chat/thread-list/lib/thread-list-cache";

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
        releaseThreadListWrites();

        const list = {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t1", createdAt: 1, status: "active", title: "Bob" }] },
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

    it("lets that account be saved again when the revoke fails, not when it succeeds", async () => {
        const list = {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t1", createdAt: 1, status: "active", title: "Bob" }] },
        };

        auth.revoke.mockRejectedValueOnce(new Error("nope"));
        render(<AccountCell deviceSession={deviceSession} />);
        fireEvent.click(screen.getByText("Revoke"));
        await vi.waitFor(() => {
            expect(readThreadListCache("bob")).toBeUndefined();
        });
        writeThreadListCache("bob", list);
        expect(readThreadListCache("bob")).toBeDefined();
    });

    it("leaves the list intact and writable when another session of the same account remains", async () => {
        const other = { session: { id: "other-2", token: "tok2" }, user: { id: "bob" } } as never;

        auth.revoke.mockResolvedValueOnce(undefined);
        render(<AccountCell deviceSession={deviceSession} deviceSessions={[deviceSession, other]} />);
        fireEvent.click(screen.getByText("Revoke"));
        await vi.waitFor(() => {
            expect(auth.revoke).toHaveBeenCalled();
        });
        await Promise.resolve();

        expect(readThreadListCache("bob")).toBeDefined();
        writeThreadListCache("bob", {
            pinnedThreads: [],
            relationships: [],
            tags: [],
            temporaryThreads: { page: [] },
            threadOrders: [],
            threads: { page: [{ _id: "t2", createdAt: 1, status: "active", title: "New" }] },
        });
        expect(readThreadListCache("bob")?.threads.map((row) => row._id)).toEqual(["t2"]);
    });

    it("clears the list when the revoked session was the account's only one", async () => {
        auth.revoke.mockResolvedValueOnce(undefined);
        render(<AccountCell deviceSession={deviceSession} deviceSessions={[deviceSession]} />);
        fireEvent.click(screen.getByText("Revoke"));

        await vi.waitFor(() => {
            expect(readThreadListCache("bob")).toBeUndefined();
        });
    });
});
