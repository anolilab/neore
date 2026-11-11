import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionAuthState } from "@/lib/auth/server-functions";

import rootBeforeLoad from "./root-before-load";

vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn(), getSessionAuthState: vi.fn() };
});

const options = (pathname: string) => {
    return {
        context: { lunoraClient: { setAuthToken: vi.fn() } },
        location: { pathname },
        serverContext: { posthog: { distinctId: "user-1", flags: { beta: true } }, security: { nonce: "n1" } },
    };
};

describe(rootBeforeLoad, () => {
    beforeEach(() => {
        vi.mocked(getSessionAuthState).mockReset().mockResolvedValue({ status: "authenticated", token: "tok" });
    });

    it("never reads the session for the offline shell, and renders it for nobody", async () => {
        const offline = options("/offline-shell");

        await expect(rootBeforeLoad(offline)).resolves.toStrictEqual({
            authStatus: "unknown",
            isAuthenticated: false,
            nonce: "n1",
            posthog: { distinctId: null, flags: {} },
            token: undefined,
        });
        expect(getSessionAuthState).not.toHaveBeenCalled();
        expect(offline.context.lunoraClient.setAuthToken).not.toHaveBeenCalled();
    });

    it("reads the session for every other path", async () => {
        const page = options("/chat/abc");

        await expect(rootBeforeLoad(page)).resolves.toStrictEqual({
            authStatus: "authenticated",
            isAuthenticated: true,
            nonce: "n1",
            posthog: { distinctId: "user-1", flags: { beta: true } },
            token: "tok",
        });
        expect(getSessionAuthState).toHaveBeenCalledOnce();
        expect(page.context.lunoraClient.setAuthToken).toHaveBeenCalledWith("tok");
    });
});
