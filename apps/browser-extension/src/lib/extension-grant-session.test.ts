import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `env.ts` reads the build's env once, at import: set it first, then load the module.
vi.stubEnv("VITE_LUNORA_URL", "https://api.example.test");

const { migrateFromCookieSession, readReconnectNeeded, RECONNECT_KEY, requestGrantAccessToken, signInWithWebAuthFlow, signOutGrant, watchReconnectNeeded } =
    await import("./extension-grant");
const { clearAccessToken, getAccessToken, resumeAccessTokens } = await import("./access-token");
const { endSession, loadGrantSession } = await import("./session");
const { createAuthTokenSync } = await import("./auth-token-sync");

const GRANT_KEY = "neore.extensionGrant";
const REDIRECT_URI = `https://${"a".repeat(32)}.chromiumapp.org/`;
const USER = { email: "a@example.test", id: "u1", image: null, name: "A" };

/** What these tests keep in storage: the grant, and the migration and notice marks. */
type Stored = boolean | number | { id?: string; token: string; user: typeof USER };

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

/** The Web Locks API, as browsers run it: one holder per name at a time, the rest queued in order. */
const installLocks = () => {
    const tails = new Map<string, Promise<unknown>>();

    vi.stubGlobal("navigator", {
        locks: {
            request: async (name: string, step: () => Promise<unknown>) => {
                const run = (tails.get(name) ?? Promise.resolve()).then(step);

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

        await signOutGrant();

        expect(sentTo(0)).toMatchObject({ body: { token: "grant" }, credentials: "omit", url: "https://api.example.test/extension/auth/revoke" });
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it("forgets it even when the revoke cannot reach the server", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockRejectedValueOnce(new TypeError("offline"));

        await signOutGrant();

        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it("keeps a grant signed in while the revoke was out", async () => {
        const newer = { id: "g2", token: "new-grant", user: { ...USER, id: "u2" } };
        const answer = deferred();

        store.set(GRANT_KEY, { token: "old-grant", user: USER });
        fetchMock.mockReturnValueOnce(answer.promise);

        const signingOut = signOutGrant();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        store.set(GRANT_KEY, newer);
        answer.resolve(new Response(null, { status: 204 }));
        await signingOut;

        expect(store.get(GRANT_KEY)).toEqual(newer);
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

        const signingOut = endSession(sync);

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
        ["read", "get"],
        ["removed", "remove"],
    ] as const)("brings the session back when the grant cannot be %s, keeping the bearer, and rejects so the failure shows", async (_label, failing) => {
        const { setAuthToken, sync } = await signedIn();

        stopSync = sync.signOut;
        vi.spyOn(chrome.storage.local, failing).mockRejectedValueOnce(new Error("storage unavailable"));

        await expect(endSession(sync)).rejects.toThrow("storage unavailable");

        expect(store.get(GRANT_KEY)).toEqual(grant);
        // The loop restarted for the grant still stored, and the bearer was never cleared.
        await vi.waitFor(() => expect(setAuthToken).toHaveBeenCalledWith(bearerFor(USER.id), USER.id));
        expect(setAuthToken).not.toHaveBeenCalledWith(null);
        await expect(getAccessToken({ force: true })).resolves.toBe(bearerFor(USER.id));
    });

    it("leaves a sign-in from another panel alone when its sign-out finishes after it", async () => {
        const { setAuthToken, sync } = await signedIn();
        const revoke = deferred();
        const newer = { token: "newer", user: { ...USER, id: "u2" } };

        fetchMock.mockReturnValueOnce(revoke.promise);

        const signingOut = endSession(sync);

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

        const signingOut = signOutGrant();

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        held.resolve(new Response(null));
        await Promise.all([refresh, signingOut]);

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

describe("loadGrantSession", () => {
    it("reads an unreadable storage as signed out, so the panel offers sign-in", async () => {
        chrome.storage.local.get = vi.fn().mockRejectedValue(new Error("storage unavailable"));

        await expect(loadGrantSession()).resolves.toBeNull();
    });

    it("keys the session to the grant, not the user", async () => {
        store.set(GRANT_KEY, { id: "g1", token: "grant", user: USER });

        await expect(loadGrantSession()).resolves.toEqual({ key: "g1", user: USER });
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

    it("stores nothing when the exchange is refused", async () => {
        launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => `${REDIRECT_URI}?code=c&state=${new URL(url).searchParams.get("state")}`);
        fetchMock.mockResolvedValueOnce(Response.json({ message: "Code expired." }, { status: 400 }));

        await expect(signInWithWebAuthFlow()).rejects.toThrow("Code expired.");
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });
});
