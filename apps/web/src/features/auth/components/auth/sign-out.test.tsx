import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { releaseThreadListWrites, writeThreadListCache } from "@/features/chat/thread-list/lib/thread-list-cache";

import SignOut from "./sign-out";

const auth = vi.hoisted(() => {
    return { outcome: "success" as "error" | "success", session: { data: null as { user: { id: string } } | null }, signOut: vi.fn() };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: { $store: { atoms: { session: { get: () => auth.session } } }, signOut: auth.signOut },
                basePath: "/auth",
                viewPaths: { SIGN_IN: "sign-in" },
            };
        },
    };
});
vi.mock("@/features/notifications/hooks/use-release-push-on-sign-out", () => {
    return { useReleasePushOnSignOut: () => async () => {} };
});
vi.mock("@/lib/analytics", () => {
    return { resetAnalyticsIdentity: vi.fn(), trackEvent: vi.fn() };
});

const list = {
    pinnedThreads: [],
    relationships: [],
    tags: [],
    temporaryThreads: { page: [] },
    threadOrders: [],
    threads: { page: [{ _id: "t1", title: "Private" }] },
};

describe("SignOut", () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        auth.session.data = null;
        releaseThreadListWrites();
        localStorage.setItem("neore-collapsed-groups", '["archived"]');
        writeThreadListCache("alice", list);
        auth.signOut.mockImplementation(async ({ fetchOptions }: { fetchOptions: { onError: () => void; onSuccess: () => void } }) => {
            fetchOptions[auth.outcome === "success" ? "onSuccess" : "onError"]();
        });
        vi.stubGlobal("location", { replace: vi.fn() });
    });

    it.each(["success", "error"] as const)("clears the stored thread list when sign-out ends in %s", async (outcome) => {
        auth.outcome = outcome;
        expect(localStorage).toHaveLength(2);

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        // Only the thread list goes; the drafts' clear marker (`dropStoredDrafts`) is new, and other settings stay.
        expect(Object.keys(localStorage).filter((key) => !key.startsWith("neore-draft-cleared:"))).toStrictEqual(["neore-collapsed-groups"]);
        expect(localStorage.getItem("neore-collapsed-groups")).toBe('["archived"]');
    });

    it.each(["success", "error"] as const)("sends the visitor to sign-in with a full load when sign-out ends in %s", async (outcome) => {
        auth.outcome = outcome;

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(globalThis.location.replace).toHaveBeenCalledWith("/auth/sign-in");
        });
        expect(globalThis.location.replace).toHaveBeenCalledTimes(1);
    });

    it("drops the signed-in account's unsent drafts, with no composer shown on this page load, and leaves another account's", async () => {
        auth.session.data = { user: { id: "alice" } };
        localStorage.setItem("neore-draft:alice:thread-a", "{}");
        localStorage.setItem("neore-draft:bob:thread-a", "{}");

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        expect(localStorage.getItem("neore-draft:alice:thread-a")).toBeNull();
        expect(localStorage.getItem("neore-draft:bob:thread-a")).toBe("{}");
    });

    it("drops every account's unsent drafts when the session does not say whose they are", async () => {
        localStorage.setItem("neore-draft:alice:thread-a", "{}");
        localStorage.setItem("neore-draft:bob:thread-a", "{}");

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(auth.signOut).toHaveBeenCalled();
        });
        expect(Object.keys(localStorage).filter((key) => key.startsWith("neore-draft:"))).toStrictEqual([]);
    });

    it("keeps the queued prompts and the signed-in hint when sign-out fails, as the session may still be active", async () => {
        auth.outcome = "error";
        localStorage.setItem("neore-signed-in-hint", "1");
        sessionStorage.setItem("neore:prompt-queue:thread-a", '{"items":[]}');

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(globalThis.location.replace).toHaveBeenCalled();
        });
        expect(localStorage.getItem("neore-signed-in-hint")).toBe("1");
        expect(sessionStorage.getItem("neore:prompt-queue:thread-a")).toBe('{"items":[]}');
    });

    it("drops the queued prompts and the signed-in hint once sign-out succeeds", async () => {
        auth.outcome = "success";
        localStorage.setItem("neore-signed-in-hint", "1");
        sessionStorage.setItem("neore:prompt-queue:thread-a", '{"items":[]}');

        render(<SignOut />);

        await vi.waitFor(() => {
            expect(globalThis.location.replace).toHaveBeenCalled();
        });
        expect(localStorage.getItem("neore-signed-in-hint")).toBeNull();
        expect(sessionStorage.getItem("neore:prompt-queue:thread-a")).toBeNull();
    });
});
