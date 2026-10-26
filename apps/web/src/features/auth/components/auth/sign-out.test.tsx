import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { writeThreadListCache } from "@/features/chat/thread-list/lib/thread-list-cache";

import SignOut from "./sign-out";

const auth = vi.hoisted(() => {
    return { outcome: "success" as "error" | "success", signOut: vi.fn() };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: { signOut: auth.signOut }, basePath: "/auth", viewPaths: { SIGN_IN: "sign-in" } };
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
        expect(localStorage).toHaveLength(1);
        expect(localStorage.getItem("neore-collapsed-groups")).toBe('["archived"]');
    });
});
