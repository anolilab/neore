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

        /** The page after a read: the client holds what the read returned. */
        const signedIn = (token: string) => {
            vi.mocked(getSessionAuthState).mockResolvedValue({ status: "authenticated", token });

            return token;
        };

        it("reads the session on the first navigation, then keeps its token without a server round trip", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(600));
            const page = options("/chat/abc", held);

            await expect(rootBeforeLoad(page)).resolves.toMatchObject({ authStatus: "authenticated", isAuthenticated: true, token: held });
            await expect(rootBeforeLoad(options("/chat/def", held))).resolves.toMatchObject({ authStatus: "authenticated", token: held });
            expect(getSessionAuthState).toHaveBeenCalledOnce();
            expect(page.context.lunoraClient.setAuthToken).toHaveBeenCalledExactlyOnceWith(held);
        });

        it("reads the session again once the last signed-in read is older than the max age", async () => {
            vi.useFakeTimers();
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(900));

            await rootBeforeLoad(options("/chat/abc", held));
            vi.advanceTimersByTime(CONFIRMED_READ_MAX_AGE_MS + 1);
            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);

            await rootBeforeLoad(options("/chat/ghi", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("reads the session when the client holds no token, or another token than the read returned", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(600));

            await rootBeforeLoad(options("/chat/abc", held));
            await rootBeforeLoad(options("/chat/def"));
            await rootBeforeLoad(options("/chat/ghi", jwt(700)));
            expect(getSessionAuthState).toHaveBeenCalledTimes(3);
        });

        it("reads the session when the token expires within a minute", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(30));

            await rootBeforeLoad(options("/chat/abc", held));
            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("reads the session after a sign-in or sign-out, then reuses the token again", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(600));

            await rootBeforeLoad(options("/chat/abc", held));
            vi.mocked(sessionChangeCount).mockReturnValue(2);
            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);

            await rootBeforeLoad(options("/chat/ghi", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("keeps asking while the session reads as signed out or fails", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);

            vi.mocked(getSessionAuthState).mockResolvedValueOnce({ status: "unauthenticated", token: undefined }).mockRejectedValueOnce(new Error("offline"));

            await expect(rootBeforeLoad(options("/chat/abc", held))).resolves.toMatchObject({ authStatus: "unauthenticated", isAuthenticated: false });
            await expect(rootBeforeLoad(options("/chat/abc", held))).resolves.toMatchObject({ authStatus: "unknown", isAuthenticated: false });
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("reads the session when it changes while a reused token's navigation is under way", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(600));

            await rootBeforeLoad(options("/chat/abc", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(1);

            // The change lands during the reuse's await: everything read after it sees the new count.
            let changed = false;

            vi.mocked(sessionChangeCount).mockImplementation(() => (changed ? 1 : 0));

            const navigation = rootBeforeLoad(options("/chat/def", held));

            changed = true;
            await navigation;
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("does not confirm a read that a session change overtook", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = signedIn(jwt(600));

            vi.mocked(sessionChangeCount).mockReturnValueOnce(1).mockReturnValue(2);
            await rootBeforeLoad(options("/chat/abc", held));
            await rootBeforeLoad(options("/chat/def", held));
            expect(getSessionAuthState).toHaveBeenCalledTimes(2);
        });

        it("lets an older signed-in answer that lands after a newer signed-out one confirm nothing", async () => {
            const rootBeforeLoad = await loadRootBeforeLoad();
            const held = jwt(600);
            let answerOlder!: (value: { status: "authenticated"; token: string }) => void;

            vi.mocked(getSessionAuthState)
                .mockReturnValueOnce(
                    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node >= 22.11; the configured range starts at 22.0
                    new Promise((resolve) => {
                        answerOlder = resolve;
                    }),
                )
                .mockResolvedValueOnce({ status: "unauthenticated", token: undefined })
                .mockResolvedValue({ status: "unauthenticated", token: undefined });

            const olderOptions = options("/chat/abc", held);
            const older = rootBeforeLoad(olderOptions);
            const newer = options("/chat/def", held);

            await rootBeforeLoad(newer);
            // The newer "no session" clears the bearer.
            expect(newer.context.lunoraClient.setAuthToken).toHaveBeenCalledWith(null);

            answerOlder({ status: "authenticated", token: held });
            await older;
            // The older signed-in answer does not put the token back.
            expect(olderOptions.context.lunoraClient.setAuthToken).not.toHaveBeenCalled();

            await expect(rootBeforeLoad(options("/chat/ghi", held))).resolves.toMatchObject({ authStatus: "unauthenticated" });
            expect(getSessionAuthState).toHaveBeenCalledTimes(3);
        });
    });
});
