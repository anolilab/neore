import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `env.ts` reads the build's env once, at import: set it first, then load the module.
vi.stubEnv("VITE_LUNORA_URL", "https://api.example.test");

const { migrateFromCookieSession, readReconnectNeeded, RECONNECT_KEY, requestGrantAccessToken, signInWithWebAuthFlow, signOutGrant } =
    await import("./extension-grant");

const GRANT_KEY = "neore.extensionGrant";
const REDIRECT_URI = `https://${"a".repeat(32)}.chromiumapp.org/`;
const USER = { email: "a@example.test", id: "u1", image: null, name: "A" };

/** What these tests keep in storage: the grant, and the migration and notice marks. */
type Stored = boolean | number | { token: string; user: typeof USER };

let store: Map<string, Stored>;
let launchWebAuthFlow: ReturnType<typeof vi.fn>;

/** `chrome.storage.local` over a plain object, and the `identity` calls sign-in makes. */
const installChrome = () => {
    store = new Map();
    launchWebAuthFlow = vi.fn();

    const keysOf = (keys: string | string[]) => (Array.isArray(keys) ? keys : [keys]);

    vi.stubGlobal("chrome", {
        identity: { getRedirectURL: () => REDIRECT_URI, launchWebAuthFlow },
        storage: {
            local: {
                get: async (keys: string | string[]) => Object.fromEntries(keysOf(keys).flatMap((key) => (store.has(key) ? [[key, store.get(key)]] : []))),
                remove: async (keys: string | string[]) => {
                    for (const key of keysOf(keys)) {
                        store.delete(key);
                    }
                },
                set: async (items: Record<string, Stored>) => {
                    for (const [key, value] of Object.entries(items)) {
                        store.set(key, value);
                    }
                },
            },
        },
    });
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    installChrome();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

afterAll(() => {
    vi.unstubAllEnvs();
});

const sentTo = (call: number) => {
    const [url, init] = fetchMock.mock.calls[call] ?? [];

    return { body: JSON.parse(String(init?.body)) as unknown, credentials: init?.credentials, url: String(url) };
};

describe("requestGrantAccessToken", () => {
    it("is null and asks nothing while signed out", async () => {
        await expect(requestGrantAccessToken()).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("trades the stored grant for a JWT, without cookies", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockResolvedValueOnce(Response.json({ token: "jwt", user: USER }));

        await expect(requestGrantAccessToken()).resolves.toBe("jwt");
        expect(sentTo(0)).toEqual({ body: { token: "grant" }, credentials: "omit", url: "https://api.example.test/extension/auth/token" });
    });

    it("drops a revoked or expired grant on 401, so the panel shows the sign-in page", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

        await expect(requestGrantAccessToken()).resolves.toBeNull();
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });

    it("keeps the grant through a server error or being offline", async () => {
        store.set(GRANT_KEY, { token: "grant", user: USER });
        fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 })).mockRejectedValueOnce(new TypeError("offline"));

        await expect(requestGrantAccessToken()).resolves.toBeNull();
        await expect(requestGrantAccessToken()).resolves.toBeNull();
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
});

describe("migrateFromCookieSession", () => {
    it("asks a Chrome install updated from the cookie build to connect, once", async () => {
        await migrateFromCookieSession({ isFirefox: false, reason: "update" });

        await expect(readReconnectNeeded()).resolves.toBe(true);

        // Signed out again later: a plain sign-in page, not the notice.
        store.delete(RECONNECT_KEY);
        await migrateFromCookieSession({ isFirefox: false, reason: "update" });

        await expect(readReconnectNeeded()).resolves.toBe(false);
    });

    it.each([
        ["a fresh install", { isFirefox: false, reason: "install" }, {}],
        ["a Firefox update", { isFirefox: true, reason: "update" }, {}],
        ["an update that already holds a grant", { isFirefox: false, reason: "update" }, { [GRANT_KEY]: { token: "grant", user: USER } }],
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
        expect(store.get(GRANT_KEY)).toEqual({ token: "grant", user: USER });
        expect(store.get(RECONNECT_KEY)).toBeUndefined();
    });

    it("stores nothing when the exchange is refused", async () => {
        launchWebAuthFlow.mockImplementationOnce(async ({ url }: { url: string }) => `${REDIRECT_URI}?code=c&state=${new URL(url).searchParams.get("state")}`);
        fetchMock.mockResolvedValueOnce(Response.json({ message: "Code expired." }, { status: 400 }));

        await expect(signInWithWebAuthFlow()).rejects.toThrow("Code expired.");
        expect(store.get(GRANT_KEY)).toBeUndefined();
    });
});
