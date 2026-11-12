import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionAuthState } from "@/lib/auth/server-functions";
import { sessionChangeCount } from "@/lib/auth/shared-session";

import { CONFIRMED_READ_MAX_AGE_MS } from "./root-before-load";

vi.mock("@/lib/auth/server-functions", () => {
    return { default: vi.fn(), getSessionAuthState: vi.fn() };
});

vi.mock("@/lib/auth/shared-session", () => {
    return { sessionChangeCount: vi.fn(() => 0) };
});

const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** A JWT with `secondsLeft` before it expires. */
const jwt = (secondsLeft: number) => {
    const now = Math.floor(Date.now() / 1000);

    return `${encode({ alg: "EdDSA" })}.${encode({ exp: now + secondsLeft, iat: now - 60, sub: "user-1" })}.signature`;
};

const options = (pathname: string, heldToken: string | null = null) => {
    return {
        context: { lunoraClient: { getAuthToken: vi.fn(() => heldToken), setAuthToken: vi.fn() } },
        location: { pathname },
        serverContext: { posthog: { distinctId: "user-1", flags: { beta: true } }, security: { nonce: "n1" } },
    };
};

/** A fresh module, as a fresh page load has: the confirmed read is module state. */
const loadRootBeforeLoad = async () => {
    vi.resetModules();

    const module = await import("./root-before-load");

    return module.default;
};

describe("rootBeforeLoad", () => {
    beforeEach(() => {
        vi.mocked(getSessionAuthState).mockReset().mockResolvedValue({ status: "authenticated", token: "tok" });
        vi.mocked(sessionChangeCount).mockReset().mockReturnValue(0);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    describe("on the server", () => {
        beforeEach(() => {
            // The offline-shell branch is server-only: the server is what renders the shell.
            vi.stubEnv("SSR", true);
        });

        it("never reads the session for the offline shell, and renders it for nobody", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
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

        it("reads the session for every other path, even when the client holds a valid token", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const page = options("/chat/abc", jwt(600));

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

    describe("in the browser", () => {
        beforeEach(() => {
            vi.stubEnv("SSR", false);
        });

        it("keeps a valid token across navigations without a server round trip", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);
            const page = options("/chat/abc", held);

            await expect(rootBeforeLoad(page)).resolves.toMatchObject({ authStatus: "authenticated", isAuthenticated: true, token: held });
            await expect(rootBeforeLoad(options("/chat/def", held))).resolves.toMatchObject({ token: held });
            expect(getSessionAuthState).not.toHaveBeenCalled();
            expect(page.context.lunoraClient.setAuthToken).not.toHaveBeenCalled();
        });

        it("reads the session again once the last signed-in read is older than the max age", async () => {
            vi.useFakeTimers();
            const rootBeforeLoad = await loadRootBeforeLoad();

            vi.advanceTimersByTime(CONFIRMED_READ_MAX_AGE_MS + 1);
            // Minted now, so the token itself is still valid.
            const held = jwt(600);

            await rootBeforeLoad(options("/chat/abc", held));
            expect(getSessionAuthState).toHaveBeenCalledOnce();

            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledOnce();
        });

        it("reads the session when the client holds no token", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();

            vi.mocked(getSessionAuthState).mockResolvedValue({ status: "unauthenticated", token: undefined });

            await expect(rootBeforeLoad(options("/chat"))).resolves.toMatchObject({ authStatus: "unauthenticated", isAuthenticated: false });
            expect(getSessionAuthState).toHaveBeenCalledOnce();
        });

        it("reads the session when the held token expires within a minute", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const page = options("/chat/abc", jwt(30));

            await expect(rootBeforeLoad(page)).resolves.toMatchObject({ token: "tok" });
            expect(getSessionAuthState).toHaveBeenCalledOnce();
            expect(page.context.lunoraClient.setAuthToken).toHaveBeenCalledWith("tok");
        });

        it("reads the session after a sign-in or sign-out, then reuses the token again", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);

            vi.mocked(sessionChangeCount).mockReturnValue(2);
            await rootBeforeLoad(options("/chat/abc", held));
            expect(getSessionAuthState).toHaveBeenCalledOnce();

            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledOnce();
        });

        it("keeps asking while the session reads as signed out or fails", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);

            vi.mocked(sessionChangeCount).mockReturnValue(1);
            vi.mocked(getSessionAuthState).mockResolvedValueOnce({ status: "unauthenticated", token: undefined }).mockRejectedValueOnce(new Error("offline"));

            await expect(rootBeforeLoad(options("/chat/abc", held))).resolves.toMatchObject({ authStatus: "unauthenticated", isAuthenticated: false });
            await expect(rootBeforeLoad(options("/chat/abc", held))).resolves.toMatchObject({ authStatus: "unknown", isAuthenticated: false });
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("does not confirm a read that a session change overtook", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);

            vi.mocked(sessionChangeCount).mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValue(2);
            await rootBeforeLoad(options("/chat/abc", held));
            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });
    });
});
