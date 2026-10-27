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

// A row the reader accepts: it needs a status and a creation time, or the stored list reads as corrupt and every "defined" check would be moot.
const listWith = (id: string, title: string) => {
    return {
        pinnedThreads: [],
        relationships: [],
        tags: [],
        temporaryThreads: { page: [] },
        threadOrders: [],
        threads: { page: [{ _id: id, createdAt: 1, status: "active", title }] },
    };
};

describe("AccountCell revoke", () => {
    beforeEach(() => {
        localStorage.clear();
        releaseThreadListWrites();

        writeThreadListCache("bob", listWith("t1", "Bob"));
        writeThreadListCache("alice", listWith("t1", "Alice"));

        // The fixtures must really be readable, or the assertions below could not tell kept from rejected.
        expect(readThreadListCache("bob")?.threads.map((row) => row._id)).toEqual(["t1"]);
        expect(readThreadListCache("alice")?.threads.map((row) => row._id)).toEqual(["t1"]);
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
        expect(readThreadListCache("alice")?.threads[0]?.title).toBe("Alice");
    });

    it("lets that account be saved again when the revoke fails", async () => {
        auth.revoke.mockRejectedValueOnce(new Error("nope"));
        render(<AccountCell deviceSession={deviceSession} />);
        fireEvent.click(screen.getByText("Revoke"));
        await vi.waitFor(() => {
            expect(readThreadListCache("bob")).toBeUndefined();
        });
        writeThreadListCache("bob", listWith("t9", "Saved again"));
        expect(readThreadListCache("bob")?.threads.map((row) => row._id)).toEqual(["t9"]);
    });

    it("leaves the list intact and writable when another session of the same account remains", async () => {
        const other = { session: { id: "other-2", token: "tok2" }, user: { id: "bob" } } as never;
        const refetch = vi.fn();

        auth.revoke.mockResolvedValueOnce(undefined);
        render(<AccountCell deviceSession={deviceSession} deviceSessions={[deviceSession, other]} refetch={refetch} />);
        fireEvent.click(screen.getByText("Revoke"));
        // refetch runs right before the handler's finally block, so once it has been called the clear decision has been made.
        await vi.waitFor(() => {
            expect(refetch).toHaveBeenCalled();
        });

        expect(readThreadListCache("bob")?.threads.map((row) => row._id)).toEqual(["t1"]);
        writeThreadListCache("bob", listWith("t2", "New"));
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
