import type { ReactElement } from "react";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `env.ts` reads the build's env once, at import: set it first, then load the module.
vi.stubEnv("VITE_LUNORA_URL", "https://api.example.test");

const {
    finishPendingSignOut,
    migrateFromCookieSession,
    readGrant,
    readReconnectNeeded,
    RECONNECT_KEY,
    requestGrantAccessToken,
    REVOKE_TIMEOUT_MS,
    SIGNED_OUT_KEY,
    signInWithWebAuthFlow,
    signOutGrant,
    watchReconnectNeeded,
} = await import("./extension-grant");
const { clearAccessToken, getAccessToken, resumeAccessTokens } = await import("./access-token");
const { endSession, useSession } = await import("./session");
const { createAuthTokenSync } = await import("./auth-token-sync");
const { AuthPage } = await import("@/features/auth/AuthPage");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const GRANT_KEY = "neore.extensionGrant";
const REDIRECT_URI = `https://${"a".repeat(32)}.chromiumapp.org/`;
const USER = { email: "a@example.test", id: "u1", image: null, name: "A" };

/** What these tests keep in storage: the grant, and the migration and notice marks. */
type Stored = boolean | number | string | { id?: string; token: string; user: typeof USER };

let store: Map<string, Stored>;
let launchWebAuthFlow: ReturnType<typeof vi.fn>;

/** `chrome.storage.local` over a plain object, and the `identity` calls sign-in makes. */
const installChrome = () => {
    store = new Map();
    launchWebAuthFlow = vi.fn();

    const keysOf = (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]);
    const listeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, area: string) => void>();
    const notify = (changes: Record<string, chrome.storage.StorageChange>) => {
        for (const listener of listeners) {
            listener(changes, "local");
        }
    };

    vi.stubGlobal("chrome", {
        identity: { getRedirectURL: () => REDIRECT_URI, launchWebAuthFlow },
        storage: {
            local: {
                get: async (keys: string | string[]) => Object.fromEntries(keysOf(keys).flatMap((key) => (store.has(key) ? [[key, store.get(key)]] : []))),
                remove: async (keys: string | string[]) => {
                    for (const key of keysOf(keys)) {
                        store.delete(key);
                        notify({ [key]: {} });
                    }
                },
                set: async (items: Record<string, Stored>) => {
                    for (const [key, value] of Object.entries(items)) {
                        store.set(key, value);
                        notify({ [key]: { newValue: value } });
                    }
                },
            },
            onChanged: {
                addListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.add(listener),
                removeListener: (listener: Parameters<typeof listeners.add>[0]) => listeners.delete(listener),
            },
        },
    });
};

/** Steps holding the grant lock (not a sign-out's own lock) right now. */
let lockHolders = 0;

/** The Web Locks API, as browsers run it: one holder per name at a time, the rest queued in order. */
const installLocks = () => {
    const tails = new Map<string, Promise<unknown>>();

    lockHolders = 0;
    vi.stubGlobal("navigator", {
        locks: {
            request: async (name: string, step: () => Promise<unknown>) => {
                const counted = name === GRANT_KEY ? 1 : 0;
                const hold = async () => {
                    lockHolders += counted;

                    try {
                        return await step();
                    } finally {
                        lockHolders -= counted;
                    }
                };
                const run = (tails.get(name) ?? Promise.resolve()).then(hold);

                tails.set(
                    name,
                    run.catch(() => undefined),
                );

                return await run;
            },
        },
    });
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    installChrome();
    installLocks();
    clearAccessToken();
    resumeAccessTokens();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

afterAll(() => {
    vi.unstubAllEnvs();
});

/** A response the test hands over when it chooses: the round trip a race needs. */
const deferred = () => {
    let settle: ((response: Response) => void) | undefined;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- the project's `lib` is ES2023, which has no `withResolvers`
    const promise = new Promise<Response>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: (response: Response) => settle?.(response) };
};

/** Render `element` the way the panel does; `unmount` ends the session watch it started. */
const mount = async (element: ReactElement) => {
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
        root.render(element);
    });

    return {
        container,
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
        },
    };
};

/** Let storage events and the reads they start settle, inside `act`. */
const settle = async () => {
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    });
};

/** The answer `launchWebAuthFlow` gives for the request it was handed: a code, with its `state`. */
const approve = async ({ url }: { url: string }) => `${REDIRECT_URI}?code=c&state=${new URL(url).searchParams.get("state")}`;

const sentTo = (call: number) => {
    const [url, init] = fetchMock.mock.calls[call] ?? [];

    return { body: JSON.parse(String(init?.body)) as unknown, credentials: init?.credentials, url: String(url) };
};

describe("requestGrantAccessToken", () => {
    it("is null and asks nothing while signed out", async () => {
        await expect(requestGrantAccessToken(undefined)).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("trades the stored grant for a JWT, without cookies", async () => {
        const grant = { token: "grant", user: USER };

        store.set(GRANT_KEY, grant);
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt", user: USER }));

        await expect(requestGrantAccessToken(grant)).resolves.toBe("jwt");
        expect(sentTo(0)).toEqual({ body: { token: "grant" }, credentials: "omit", url: "https://api.example.test/extension/auth/token" });
    });

    it("drops a revoked or expired grant on 401, so the panel shows the sign-in page", async () => {
        const grant = { token: "grant", user: USER };

        store.set(GRANT_KEY, grant);
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

        await expect(requestGrantAccessToken(grant)).resolves.toBeNull();
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it.each([
        ["a 401", () => new Response(null, { status: 401 })],
        ["a renamed profile", () => Response.json({ token: "jwt", user: { ...USER, name: "Old" } })],
    ])("leaves a grant signed in while the refresh was out alone on %s", async (_label, response) => {
        const old = { token: "old-grant", user: USER };
        const newer = { id: "g2", token: "new-grant", user: { ...USER, id: "u2" } };
        const answer = deferred();

        store.set(GRANT_KEY, old);
        fetchMock.mockReturnValueOnce(answer.promise);

        const refresh = requestGrantAccessToken(old);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.set(GRANT_KEY, newer);
        answer.resolve(response());
        await refresh;

        expect(store.get(GRANT_KEY)).toEqual(newer);
    });

    it("keeps the grant through a server error or being offline", async () => {
        const grant = { token: "grant", user: USER };

        store.set(GRANT_KEY, grant);
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockRejectedValueOnce(new TypeError("offline"));

        await expect(requestGrantAccessToken(grant)).resolves.toBeNull();
        await expect(requestGrantAccessToken(grant)).resolves.toBeNull();
        expect(store.get(GRANT_KEY)).toEqual({ token: "grant", user: USER });
    });
});

describe("signOutGrant", () => {
    it("revokes the session server side, then forgets it", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

        await signOutGrant(USER.id);

        expect(sentTo(0)).toMatchObject({ body: { token: "grant" }, credentials: "omit", url: "https://api.example.test/extension/auth/revoke" });
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it("forgets it even when the revoke cannot reach the server", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockRejectedValueOnce(new TypeError("offline"));

        await signOutGrant(USER.id);

        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it("revokes nothing when the grant stored is not the one shown, even for the same user", async () => {
        const newer = { id: "g2", token: "new-grant", user: USER };

        store.set(GRANT_KEY, newer);

        await expect(signOutGrant("g1")).resolves.toBe("replaced");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.get(GRANT_KEY)).toEqual(newer);
    });

    it("keeps a grant signed in while the revoke was out", async () => {
        const newer = { id: "g2", token: "new-grant", user: { ...USER, id: "u2" } };
        const answer = deferred();

        store.set(GRANT_KEY, { token: "old-grant", user: USER });
        fetchMock.mockReturnValueOnce(answer.promise);

        const signingOut = signOutGrant(USER.id);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.set(GRANT_KEY, newer);
        answer.resolve(new Response(null, { status: 204 }));
        await signingOut;

        expect(store.get(GRANT_KEY)).toEqual(newer);
    });

    it("never overwrites the mark of a grant signed in and out while it read its own", async () => {
        const newerRevoke = deferred();
        const { get } = chrome.storage.local;
        let newerSignOut: Promise<unknown> | undefined;

        const signInAndOutAgain = async () => {
            await signInWithWebAuthFlow();

            const newerKey = (store.get(GRANT_KEY) as { id: string }).id;

            newerSignOut = signOutGrant(newerKey);
            await vi.waitFor(() => expect(store.get(SIGNED_OUT_KEY)).toBe(newerKey));
        };

        store.set(GRANT_KEY, { id: "g1", token: "grant-1", user: USER });
        launchWebAuthFlow.mockImplementation(approve);
        fetchMock.mockImplementation(async (input, init) => {
            if (String(input).endsWith("/exchange")) {
                return Response.json({ token: "grant-2", user: USER });
            }

            return (JSON.parse(String(init?.body)) as { token: string }).token === "grant-2" ? await newerRevoke.promise : new Response(null, { status: 204 });
        });
        // Whatever can land between the older sign-out's read of its grant and its mark lands there.
        chrome.storage.local.get = vi.fn(async (keys: string[]) => {
            chrome.storage.local.get = get;

            const read = await get(keys);

            if (lockHolders === 0) {
                await signInAndOutAgain();
            }

            return read;
        }) as unknown as typeof get;

        await signOutGrant("g1");

        if (!newerSignOut) {
            await signInAndOutAgain();
        }

        // The newer grant is still being signed out: nothing reads it.
        await expect(readGrant()).resolves.toBeUndefined();

        newerRevoke.resolve(new Response(null, { status: 204 }));
        await newerSignOut;
    });
});

describe("endSession", () => {
    const grant = { token: "grant", user: USER };
    /** The bearer the token endpoint mints for `sub`; only its payload is read. */
    const bearerFor = (sub: string): string => `h.${btoa(JSON.stringify({ sub })).replaceAll("=", "")}.s`;

    /** A panel signed in with `grant`: a real bearer sync over a fake Lunora client. */
    const signedIn = async () => {
        const setAuthToken = vi.fn();
        const sync = createAuthTokenSync({ setAuthToken }, getAccessToken);

        store.set(GRANT_KEY, grant);
        // The token endpoint answers with the stored grant's own user, whichever grant asks.
        fetchMock.mockImplementation(async (input) => {
            if (String(input).endsWith("/revoke")) {
                return new Response(null, { status: 204 });
            }

            const { user } = store.get(GRANT_KEY) as typeof grant;

            return Response.json({ token: bearerFor(user.id), user });
        });
        sync.start(USER.id);
        await vi.waitFor(() => expect(setAuthToken).toHaveBeenCalledWith(bearerFor(USER.id), USER.id));
        setAuthToken.mockClear();

        return { setAuthToken, sync };
    };

    let stopSync: (() => void) | undefined;

    afterEach(() => {
        stopSync?.();
        stopSync = undefined;
    });

    it("holds tokens and keeps the bearer while the grant is removed, then clears it", async () => {
        const { setAuthToken, sync } = await signedIn();
        const revoke = deferred();

        stopSync = sync.signOut;
        fetchMock.mockReturnValueOnce(revoke.promise);

        const signingOut = endSession(sync, USER.id);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything()));
        // Pending: no new token, and the bearer (with its offline queue) stays.
        await expect(getAccessToken({ force: true })).resolves.toBeNull();
        expect(setAuthToken).not.toHaveBeenCalled();

        revoke.resolve(new Response(null, { status: 204 }));
        await signingOut;

        expect(store.has(GRANT_KEY)).toBe(false);
        expect(setAuthToken.mock.calls).toEqual([[null]]);
        await expect(getAccessToken({ force: true })).resolves.toBeNull();
    });

    it.each([
        ["cannot be read", "get"],
        ["cannot be marked signed out", "set"],
    ] as const)("brings the session back when the grant %s, keeping the bearer, and rejects so the failure shows", async (_label, failing) => {
        const { setAuthToken, sync } = await signedIn();

        stopSync = sync.signOut;
        vi.spyOn(chrome.storage.local, failing).mockRejectedValueOnce(new Error("storage unavailable"));

        await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");

        expect(store.get(GRANT_KEY)).toEqual(grant);
        // The loop restarted for the grant still stored, and the bearer was never cleared.
        await vi.waitFor(() => expect(setAuthToken).toHaveBeenCalledWith(bearerFor(USER.id), USER.id));
        expect(setAuthToken).not.toHaveBeenCalledWith(null);
        await expect(getAccessToken({ force: true })).resolves.toBe(bearerFor(USER.id));
    });

    it("ends within the timeout when the revoke never answers, and forgets the grant", async () => {
        const { setAuthToken, sync } = await signedIn();
        const timeout = new AbortController();

        stopSync = sync.signOut;
        vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
            expect(ms).toBe(REVOKE_TIMEOUT_MS);

            return timeout.signal;
        });
        // A revoke that never answers: only its signal ends it.
        fetchMock.mockImplementationOnce(
            async (_input, init) =>
                await new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
                }),
        );

        const signingOut = endSession(sync, USER.id);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything()));
        timeout.abort(new DOMException("timed out", "TimeoutError"));

        await expect(signingOut).resolves.toBeUndefined();
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
        expect(setAuthToken.mock.calls).toEqual([[null]]);
    });

    it("forgets the grant when the revoke answers but its body never finishes cancelling", async () => {
        const { setAuthToken, sync } = await signedIn();
        const cancel = vi.fn(
            async () =>
                await new Promise<void>(() => {
                    // Never settles.
                }),
        );
        const revoked = new Response(null, { status: 204 });

        stopSync = sync.signOut;
        // Headers arrived; the body's cancel never settles.
        Object.defineProperty(revoked, "body", { value: { cancel } });
        fetchMock.mockResolvedValueOnce(revoked);

        await expect(endSession(sync, USER.id)).resolves.toBeUndefined();

        expect(cancel).toHaveBeenCalledOnce();
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
        expect(setAuthToken.mock.calls).toEqual([[null]]);
    });

    it("never signs back in from a grant whose removal failed, in this panel or a new one, and the next panel removes it", async () => {
        const { setAuthToken, sync } = await signedIn();

        stopSync = sync.signOut;
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(new Error("storage unavailable"));
        fetchMock.mockRejectedValueOnce(new TypeError("offline"));

        await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");

        // Still stored, but marked: this panel cleared its bearer, and nothing hands out a token for it.
        expect(store.get(GRANT_KEY)).toEqual(grant);
        expect(setAuthToken.mock.calls).toEqual([[null]]);
        await expect(getAccessToken({ force: true })).resolves.toBeNull();

        // A panel opened later reads no session, and removes the leftover.
        resumeAccessTokens();
        clearAccessToken();
        await expect(readGrant()).resolves.toBeUndefined();
        await expect(getAccessToken({ force: true })).resolves.toBeNull();
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/token"))).toHaveLength(1);

        await finishPendingSignOut();

        expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything());
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
    });

    it("does not bring back a grant the server revoked when only its removal failed", async () => {
        const { setAuthToken, sync } = await signedIn();

        stopSync = sync.signOut;
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(new Error("storage unavailable"));

        await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");

        expect(setAuthToken.mock.calls).toEqual([[null]]);
        await expect(getAccessToken({ force: true })).resolves.toBeNull();
    });

    const storageUnavailable = new Error("storage unavailable");
    const warningOf = (page: { container: HTMLElement }) =>
        [...page.container.querySelectorAll("[role=alert]")].find((alert) => alert.textContent?.startsWith("Sign-out did not finish"));

    it("tells the sign-in page, which replaces Settings, when storage kept the grant", async () => {
        const { sync } = await signedIn();

        stopSync = sync.signOut;
        const page = await mount(createElement(AuthPage));

        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);

        await act(async () => {
            await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");
        });
        await settle();

        expect(warningOf(page)).toBeDefined();
        await page.unmount();
    });

    it("tells this panel's sign-in page when storage kept the grant and refused the failure mark too", async () => {
        const { sync } = await signedIn();

        stopSync = sync.signOut;
        const page = await mount(createElement(AuthPage));
        const { set } = chrome.storage.local;

        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);
        vi.spyOn(chrome.storage.local, "set").mockImplementation(async (items: Record<string, Stored>) => {
            if (Object.hasOwn(items, "neore.signOutFailed")) {
                throw storageUnavailable;
            }

            await set(items);
        });

        await act(async () => {
            await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");
        });
        await settle();

        expect(store.has("neore.signOutFailed")).toBe(false);
        expect(warningOf(page)).toBeDefined();
        await page.unmount();
    });

    it("shows no warning in another panel while a sign-out runs there, and shows it once that removal fails", async () => {
        store.set(GRANT_KEY, grant);
        const page = await mount(createElement(AuthPage));
        const revoke = deferred();

        fetchMock.mockReturnValueOnce(revoke.promise);
        // Another panel's sign-out: this panel runs no removal of its own.
        const signingOut = signOutGrant(USER.id);

        await vi.waitFor(() => expect(store.get(SIGNED_OUT_KEY)).toBe(USER.id));
        await settle();
        expect(warningOf(page)).toBeUndefined();

        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);
        revoke.resolve(new Response(null, { status: 204 }));
        await act(async () => {
            await expect(signingOut).rejects.toThrow("storage unavailable");
        });
        await settle();

        expect(warningOf(page)).toBeDefined();
        await page.unmount();
    });

    it("lets a panel opened during another panel's sign-out wait for it, with no second revoke and no warning", async () => {
        store.set(GRANT_KEY, grant);
        const revoke = deferred();

        fetchMock.mockReturnValueOnce(revoke.promise).mockResolvedValue(new Response(null, { status: 204 }));
        // Another panel's sign-out has marked the grant and waits on its revoke.
        const signingOut = signOutGrant(USER.id);

        await vi.waitFor(() => expect(store.get(SIGNED_OUT_KEY)).toBe(USER.id));

        // This panel opens now: its leftover cleanup reads the mark.
        const page = await mount(createElement(AuthPage));

        await settle();
        expect(warningOf(page)).toBeUndefined();
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);

        revoke.resolve(new Response(null, { status: 204 }));
        await act(async () => {
            await expect(signingOut).resolves.toBe("signed-out");
        });
        await settle();

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(warningOf(page)).toBeUndefined();
        await page.unmount();
    });

    it("lets a panel that waited on a sign-out whose removal failed retry it once that sign-out ends", async () => {
        store.set(GRANT_KEY, grant);
        const revoke = deferred();

        fetchMock.mockReturnValueOnce(revoke.promise).mockResolvedValue(new Response(null, { status: 204 }));
        const signingOut = signOutGrant(USER.id);

        await vi.waitFor(() => expect(store.get(SIGNED_OUT_KEY)).toBe(USER.id));

        const page = await mount(createElement(AuthPage));

        await settle();
        // The other panel's removal fails; this panel's waiting cleanup then tries again, and succeeds.
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);
        revoke.resolve(new Response(null, { status: 204 }));
        await act(async () => {
            await expect(signingOut).rejects.toThrow("storage unavailable");
        });
        await settle();

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(2);
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
        expect(warningOf(page)).toBeUndefined();
        await page.unmount();
    });

    it("writes no failure mark for an offline sign-out whose removal succeeds, so no other panel warns", async () => {
        store.set(GRANT_KEY, grant);
        const page = await mount(createElement(AuthPage));
        const set = vi.spyOn(chrome.storage.local, "set");

        fetchMock.mockRejectedValueOnce(new TypeError("offline"));

        await act(async () => {
            await expect(signOutGrant(USER.id)).resolves.toBe("signed-out");
        });
        await settle();

        expect(set.mock.calls.some(([items]) => Object.hasOwn(items, "neore.signOutFailed"))).toBe(false);
        expect(store.has(GRANT_KEY)).toBe(false);
        expect(warningOf(page)).toBeUndefined();
        await page.unmount();
    });

    it("shows the warning in a second panel whose retry fails too", async () => {
        const { sync } = await signedIn();

        stopSync = sync.signOut;
        // This panel's own sign-out finished.
        await endSession(sync, USER.id);

        // Another panel's sign-out marked its grant and could not remove it.
        store.set(GRANT_KEY, grant);
        store.set(SIGNED_OUT_KEY, USER.id);
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);

        const page = await mount(createElement(AuthPage));

        await settle();

        expect(store.get(GRANT_KEY)).toEqual(grant);
        expect(warningOf(page)).toBeDefined();
        await page.unmount();
    });

    it("clears the warning once cleanup succeeds", async () => {
        store.set(GRANT_KEY, grant);
        store.set(SIGNED_OUT_KEY, USER.id);
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);

        const page = await mount(createElement(AuthPage));

        await settle();
        expect(warningOf(page)).toBeDefined();

        // Another panel's retry removes the leftover.
        await act(async () => {
            await finishPendingSignOut();
        });
        await settle();

        expect(store.has(GRANT_KEY)).toBe(false);
        expect(warningOf(page)).toBeUndefined();
        await page.unmount();
    });

    it("shows no stale warning after another panel's sign-in replaced the grant and that session ended", async () => {
        const { sync } = await signedIn();

        stopSync = sync.signOut;
        const page = await mount(createElement(AuthPage));

        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable);
        await act(async () => {
            await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");
        });
        await settle();
        expect(warningOf(page)).toBeDefined();

        // Another panel signs in (the new grant replaces the marked one, the mark goes) ...
        await act(async () => {
            await chrome.storage.local.set({ [GRANT_KEY]: { id: "g2", token: "newer", user: USER } });
            await chrome.storage.local.remove(SIGNED_OUT_KEY);
        });
        await settle();
        expect(warningOf(page)).toBeUndefined();

        // ... and that session ends another way: a 401 drops its grant.
        await act(async () => {
            await chrome.storage.local.remove(GRANT_KEY);
        });
        await settle();

        expect(warningOf(page)).toBeUndefined();
        await page.unmount();
    });

    it("keeps the sign-in page's warning through a sign-in that is denied", async () => {
        const { sync } = await signedIn();

        stopSync = sync.signOut;
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(storageUnavailable).mockRejectedValueOnce(storageUnavailable);

        await expect(endSession(sync, USER.id)).rejects.toThrow("storage unavailable");

        Reflect.set(chrome, "permissions", { request: async () => false });

        // A new panel: its retry fails too, so the grant stays and so does the warning.
        const page = await mount(createElement(AuthPage));

        await settle();
        await act(async () => {
            page.container.querySelector("button")?.click();
        });
        await settle();

        const alerts = [...page.container.querySelectorAll("[role=alert]")].map((alert) => alert.textContent);

        expect(alerts).toContainEqual(expect.stringMatching(/^Anole needs access/u));
        expect(alerts).toContainEqual(expect.stringMatching(/^Sign-out did not finish/u));
        await page.unmount();
    });

    it("runs one sign-out per grant: a second call joins the first", async () => {
        const { setAuthToken, sync } = await signedIn();
        const revoke = deferred();

        stopSync = sync.signOut;
        fetchMock.mockReturnValueOnce(revoke.promise);

        const first = endSession(sync, USER.id);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything()));

        const second = endSession(sync, USER.id);

        revoke.resolve(new Response(null, { status: 204 }));
        await Promise.all([first, second]);

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);
        expect(setAuthToken.mock.calls).toEqual([[null]]);
    });

    it("keeps tokens held for a newer grant's sign-out when an older one finds its grant replaced", async () => {
        const { sync } = await signedIn();
        const revoke = deferred();
        const newer = { id: "g2", token: "newer", user: { ...USER, id: "u2" } };

        stopSync = sync.signOut;
        store.set(GRANT_KEY, newer);
        fetchMock.mockReturnValueOnce(revoke.promise);

        // The newer grant's sign-out is revoking; the older one finds its grant replaced and ends.
        const newerSignOut = endSession(sync, "g2");

        await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything()));
        await expect(endSession(sync, USER.id)).resolves.toBeUndefined();

        await expect(getAccessToken()).resolves.toBeNull();

        revoke.resolve(new Response(null, { status: 204 }));
        await newerSignOut;
    });

    it("leaves another grant stored since the page was shown signed in, and resolves", async () => {
        const { setAuthToken, sync } = await signedIn();
        const newer = { id: "g2", token: "newer", user: { ...USER, id: "u2" } };

        stopSync = sync.signOut;
        store.set(GRANT_KEY, newer);

        await expect(endSession(sync, USER.id)).resolves.toBeUndefined();

        expect(store.get(GRANT_KEY)).toEqual(newer);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(0);
        await vi.waitFor(() => expect(setAuthToken).toHaveBeenLastCalledWith(bearerFor("u2"), "u2"));
    });

    it("leaves a sign-in from another panel alone when its sign-out finishes after it", async () => {
        const { setAuthToken, sync } = await signedIn();
        const revoke = deferred();
        const newer = { token: "newer", user: { ...USER, id: "u2" } };

        fetchMock.mockReturnValueOnce(revoke.promise);

        const signingOut = endSession(sync, USER.id);

        await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/extension/auth/revoke" }), expect.anything()));
        // Another panel signs in; this panel's provider starts the new session.
        store.set(GRANT_KEY, newer);
        resumeAccessTokens();
        stopSync = sync.start(newer.user.id);
        revoke.resolve(new Response(null, { status: 204 }));
        await signingOut;

        expect(store.get(GRANT_KEY)).toEqual(newer);
        // Only the account switch cleared the bearer; the finished sign-out did not.
        expect(setAuthToken.mock.calls.filter(([token]) => token === null)).toHaveLength(1);
        await vi.waitFor(() => expect(setAuthToken).toHaveBeenLastCalledWith(bearerFor("u2"), "u2"));
        await expect(getAccessToken()).resolves.toBe(bearerFor("u2"));
    });
});

describe("a refresh against a sign-out", () => {
    it("lets a sign-out that lands between the refresh's check and its write win", async () => {
        const grant = { token: "grant", user: USER };
        const { set } = chrome.storage.local;
        const held = deferred();
        const write = vi.fn(async (items: Record<string, Stored>) => {
            // The refresh's write stalls after its check passed.
            await held.promise;
            await set(items);
        });

        store.set(GRANT_KEY, grant);
        chrome.storage.local.set = write as unknown as typeof set;
        fetchMock
            .mockResolvedValueOnce(Response.json({ token: "jwt", user: { ...USER, name: "Renamed" } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));

        const refresh = requestGrantAccessToken(grant);

        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));

        const signingOut = signOutGrant(USER.id);

        // The sign-out has read the grant and queues its mark behind the refresh's write.
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
        held.resolve(new Response(null));
        await Promise.all([refresh, signingOut]);

        expect(fetchMock).toHaveBeenCalledTimes(2);

        expect(store.get(GRANT_KEY)).toBeUndefined();
    });
});

describe("getAccessToken", () => {
    it("never hands out a JWT minted for a grant that is no longer stored", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant-1", user: USER });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt-1", user: USER }));
        await expect(getAccessToken()).resolves.toBe("jwt-1");

        // Cached for the same grant.
        await expect(getAccessToken()).resolves.toBe("jwt-1");
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Signed out: nothing, without asking.
        store.delete(GRANT_KEY);
        await expect(getAccessToken()).resolves.toBeNull();

        // Another account signed in (here without the sign-out between): its own JWT.
        const other = { ...USER, id: "u2" };

        store.set(GRANT_KEY, { id: "g2", token: "grant-2", user: other });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt-2", user: other }));
        await expect(getAccessToken()).resolves.toBe("jwt-2");
        expect(sentTo(1).body).toEqual({ token: "grant-2" });
    });

    it("does not cache a late answer for a grant replaced while it was out", async () => {
        const answer = deferred();

        store.set(GRANT_KEY, { id: "g1", token: "grant-1", user: USER });
        fetchMock.mockReturnValueOnce(answer.promise);

        const first = getAccessToken();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.set(GRANT_KEY, { id: "g2", token: "grant-2", user: USER });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt-2", user: USER }));
        await expect(getAccessToken()).resolves.toBe("jwt-2");

        answer.resolve(Response.json({ token: "jwt-1", user: USER }));

        // Whoever waited gets the grant stored now, not the one it asked under.
        await expect(first).resolves.toBe("jwt-2");
        await expect(getAccessToken()).resolves.toBe("jwt-2");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("hands a caller waiting through an account switch the new account's JWT", async () => {
        const answer = deferred();
        const other = { ...USER, id: "u2" };

        store.set(GRANT_KEY, { id: "g1", token: "grant-1", user: USER });
        fetchMock.mockReturnValueOnce(answer.promise);

        const waiting = getAccessToken();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.set(GRANT_KEY, { id: "g2", token: "grant-2", user: other });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt-2", user: other }));
        answer.resolve(Response.json({ token: "jwt-1", user: USER }));

        await expect(waiting).resolves.toBe("jwt-2");
        expect(sentTo(1).body).toEqual({ token: "grant-2" });
    });
});

describe("useSession", () => {
    /** What each render of `useSession` showed: the session key, `null` signed out, `undefined` loading. */
    let seen: (string | null | undefined)[];

    const Probe = () => {
        const { data, isPending } = useSession();

        seen.push(isPending ? undefined : (data?.sessionId ?? null));

        return null;
    };

    beforeEach(() => {
        seen = [];
    });

    it("reads an unreadable storage as signed out on the first read, so the panel offers sign-in", async () => {
        chrome.storage.local.get = vi.fn().mockRejectedValue(new Error("storage unavailable"));

        const panel = await mount(createElement(Probe));

        await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
        await panel.unmount();
    });

    it("signs out once storage recovers from an outage in which another panel marked the grant", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant", user: USER });

        const panel = await mount(createElement(Probe));

        await vi.waitFor(() => expect(seen.at(-1)).toBe("g1"));
        vi.useFakeTimers();

        try {
            const get = vi.spyOn(chrome.storage.local, "get");

            // The read the mark's change starts, and every retry for the next 7 s, fail.
            for (let failure = 0; failure < 5; failure += 1) {
                get.mockRejectedValueOnce(new Error("storage unavailable"));
            }

            await act(async () => {
                await chrome.storage.local.set({ [SIGNED_OUT_KEY]: "g1" });
            });

            expect(seen.at(-1)).toBe("g1");

            // Storage recovers with no new change event: only a retry reads the mark.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });

            expect(seen.at(-1)).toBeNull();
        } finally {
            vi.useRealTimers();
        }

        await panel.unmount();
    });

    it("keeps the session through a storage read that fails after a change, and still ends on a mark", async () => {
        const grant = { id: "g1", token: "grant", user: USER };

        store.set(GRANT_KEY, grant);

        const panel = await mount(createElement(Probe));

        await vi.waitFor(() => expect(seen.at(-1)).toBe("g1"));
        vi.spyOn(chrome.storage.local, "get").mockRejectedValueOnce(new Error("storage unavailable"));
        await act(async () => {
            await chrome.storage.local.set({ [GRANT_KEY]: grant });
        });
        await settle();

        expect(seen).not.toContain(null);

        await act(async () => {
            await chrome.storage.local.set({ [SIGNED_OUT_KEY]: "g1" });
        });
        await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
        await panel.unmount();
    });

    it("reads again after a failed read, so a sign-in from signed out still shows", async () => {
        const panel = await mount(createElement(Probe));

        await vi.waitFor(() => expect(seen.at(-1)).toBeNull());
        vi.spyOn(chrome.storage.local, "get").mockRejectedValueOnce(new Error("storage unavailable"));
        await act(async () => {
            await chrome.storage.local.set({ [GRANT_KEY]: { id: "g1", token: "grant", user: USER } });
        });

        await vi.waitFor(() => expect(seen.at(-1)).toBe("g1"));
        await panel.unmount();
    });

    it("removes a marked grant once storage recovers from failing as the panel opened, without reopening it", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant", user: USER });
        store.set(SIGNED_OUT_KEY, "g1");
        fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));

        // The first read and the leftover cleanup's read both fail.
        vi.spyOn(chrome.storage.local, "get").mockRejectedValueOnce(new Error("storage unavailable")).mockRejectedValueOnce(new Error("storage unavailable"));

        const panel = await mount(createElement(Probe));

        await vi.waitFor(() => expect(store.has(GRANT_KEY)).toBe(false));
        await settle();

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);
        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
        expect(seen.at(-1)).toBeNull();
        await panel.unmount();
    });

    it("backs off a leftover cleanup whose storage reads keep failing while the session reads succeed", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant", user: USER });
        store.set(SIGNED_OUT_KEY, "g1");
        vi.useFakeTimers();

        try {
            const { get } = chrome.storage.local;
            let cleanupReads = 0;

            // The session's reads succeed; the cleanup's (`finishPendingSignOut`, on the call stack) fail,
            // the first 50 of them, so a retry with no delay ends instead of hanging the test.
            chrome.storage.local.get = vi.fn().mockImplementation(async (keys: string[]) => {
                if (cleanupReads < 50 && new Error("stack").stack?.includes("finishPendingSignOut")) {
                    cleanupReads += 1;

                    throw new Error("storage unavailable");
                }

                return await get(keys);
            });

            const panel = await mount(createElement(Probe));

            // 250 ms doubling to 30 s: 8 tries in the first 32 s, then one each 30 s.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(60_000);
            });

            expect(cleanupReads).toBeGreaterThan(1);
            expect(cleanupReads).toBeLessThanOrEqual(10);
            expect(store.has(GRANT_KEY)).toBe(true);
            await panel.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it("finishes a pending sign-out once per panel, however many components read the session", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant", user: USER });
        store.set(SIGNED_OUT_KEY, "g1");
        fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));

        const panel = await mount(createElement(Fragment, null, createElement(Probe), createElement(Probe), createElement(Probe)));

        await vi.waitFor(() => expect(store.has(GRANT_KEY)).toBe(false));
        await settle();

        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(1);
        expect(seen.at(-1)).toBeNull();
        await panel.unmount();
    });
});

describe("migrateFromCookieSession", () => {
    const signedIn = async () => true;

    it("asks a Chrome install signed in with the cookie build to connect, once", async () => {
        await migrateFromCookieSession({ hadCookieSession: signedIn, isFirefox: false, reason: "update" });

        await expect(readReconnectNeeded()).resolves.toBe(true);

        // Signed out again later: a plain sign-in page, not the notice.
        store.delete(RECONNECT_KEY);
        await migrateFromCookieSession({ hadCookieSession: signedIn, isFirefox: false, reason: "update" });

        await expect(readReconnectNeeded()).resolves.toBe(false);
    });

    it("reaches a sign-in page that opened before the mark was written", async () => {
        const seen: boolean[] = [];
        const stop = watchReconnectNeeded((needed) => {
            seen.push(needed);
        });

        await vi.waitFor(() => expect(seen).toEqual([false]));
        await migrateFromCookieSession({ hadCookieSession: signedIn, isFirefox: false, reason: "update" });
        stop();

        expect(seen).toEqual([false, true]);
    });

    it.each([
        ["a fresh install", { hadCookieSession: signedIn, isFirefox: false, reason: "install" }, {}],
        ["a Firefox update", { hadCookieSession: signedIn, isFirefox: true, reason: "update" }, {}],
        [
            "an update that already holds a grant",
            { hadCookieSession: signedIn, isFirefox: false, reason: "update" },
            { [GRANT_KEY]: { token: "grant", user: USER } },
        ],
        ["an update nobody signed in to", { hadCookieSession: async () => false, isFirefox: false, reason: "update" }, {}],
        [
            "an update that signed in while the cache was read",
            {
                hadCookieSession: async () => {
                    store.set(GRANT_KEY, { token: "grant", user: USER });

                    return true;
                },
                isFirefox: false,
                reason: "update",
            },
            {},
        ],
        [
            "an update whose sign-in check fails",
            {
                hadCookieSession: async () => {
                    throw new Error("blocked");
                },
                isFirefox: false,
                reason: "update",
            },
            {},
        ],
    ])("shows no notice after %s", async (_label, input, initial) => {
        for (const [key, value] of Object.entries(initial)) {
            store.set(key, value);
        }

        await migrateFromCookieSession(input);

        await expect(readReconnectNeeded()).resolves.toBe(false);
    });
});

describe("signInWithWebAuthFlow", () => {
    it("exchanges the code for a grant with its verifier, stores it and clears the reconnect notice", async () => {
        store.set(RECONNECT_KEY, true);
        launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => {
            const state = new URL(url).searchParams.get("state");

            return `${REDIRECT_URI}?code=one-time&state=${state}`;
        });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "grant", user: USER }));

        await expect(signInWithWebAuthFlow()).resolves.toEqual(USER);

        const { body, credentials, url } = sentTo(0);

        expect(url).toBe("https://api.example.test/extension/auth/exchange");
        expect(credentials).toBe("omit");
        expect(body).toMatchObject({ code: "one-time", redirectUri: REDIRECT_URI });
        expect((body as { codeVerifier: string }).codeVerifier).toMatch(/^[\w-]{43}$/);
        expect(store.get(GRANT_KEY)).toEqual({ id: expect.stringMatching(/^[\w-]{43}$/), token: "grant", user: USER });
        expect(store.get(RECONNECT_KEY)).toBeUndefined();
    });

    it("signs in again over a grant left by a failed sign-out, and drops its mark", async () => {
        store.set(GRANT_KEY, { token: "left-over", user: USER });
        store.set(SIGNED_OUT_KEY, USER.id);
        launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => `${REDIRECT_URI}?code=c&state=${new URL(url).searchParams.get("state")}`);
        fetchMock.mockResolvedValueOnce(Response.json({ token: "fresh", user: USER }));

        await signInWithWebAuthFlow();

        expect(store.has(SIGNED_OUT_KEY)).toBe(false);
        await expect(readGrant()).resolves.toMatchObject({ user: USER });
    });

    it("signs in when storage fails to drop an older grant's mark, which hides nothing", async () => {
        store.set(SIGNED_OUT_KEY, "an-older-grant");
        launchWebAuthFlow.mockImplementationOnce(approve);
        fetchMock.mockResolvedValueOnce(Response.json({ token: "fresh", user: USER }));
        vi.spyOn(chrome.storage.local, "remove").mockRejectedValueOnce(new Error("storage unavailable"));

        await expect(signInWithWebAuthFlow()).resolves.toEqual(USER);
        await expect(readGrant()).resolves.toMatchObject({ user: USER });
    });

    it("stores nothing when the exchange is refused", async () => {
        launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => `${REDIRECT_URI}?code=c&state=${new URL(url).searchParams.get("state")}`);
        fetchMock.mockResolvedValueOnce(Response.json({ message: "Code expired." }, { status: 400 }));

        await expect(signInWithWebAuthFlow()).rejects.toThrow("Code expired.");
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });
});
