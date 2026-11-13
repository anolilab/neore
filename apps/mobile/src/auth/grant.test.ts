import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Fetch, GrantStore, StoredGrant } from "./grant";
import { buildAuthorizeUrl, createPkce, exchangeGrant, fetchAccessToken, parseAuthorizeResponse, readStoredUser, revokeSessionToken, SignInError, takeStoredGrant, toBase64Url } from "./grant";

const REDIRECT = "neore-mobile://auth/callback";
const LUNORA = "https://backend.example";
const USER = { email: "a@b.c", id: "u1", image: null, name: "A" };

const memoryStore = (initial: StoredGrant | null = null): GrantStore & { value: StoredGrant | null } => {
    const store = {
        clear: async () => {
            store.value = null;
        },
        get: async () => store.value,
        set: async (grant: StoredGrant) => {
            store.value = grant;
        },
        value: initial,
    };

    return store;
};

const json = (body: unknown, status = 200): Response => Response.json(body, { headers: { "Content-Type": "application/json" }, status });

describe("PKCE", () => {
    it("matches the RFC 7636 appendix B vector", async () => {
        const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const pkce = await createPkce({
            digestBase64: async (input) => createHash("sha256").update(input).digest("base64"),
            randomBytes: (count) => new Uint8Array(count).fill(1),
        });

        expect(pkce.verifier).toHaveLength(43);
        const challenge = toBase64Url(createHash("sha256").update(pkce.verifier).digest("base64"));

        expect(challenge).toHaveLength(43);

        const fixed = await createPkce({
            digestBase64: async (input) => {
                if (input === verifier) {
                    return "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM=";
                }

                return "x";
            },
            randomBytes: () => Buffer.from(verifier, "base64url").subarray(0, 32),
        });

        expect(fixed.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });
});

describe("parseAuthorizeResponse", () => {
    const input = { redirectUri: REDIRECT, state: "s1" };

    it("returns the code from a custom-scheme callback", () => {
        expect(parseAuthorizeResponse(`${REDIRECT}?code=abc&state=s1`, input)).toBe("abc");
    });

    it("rejects a state mismatch", () => {
        expect(() => parseAuthorizeResponse(`${REDIRECT}?code=abc&state=other`, input)).toThrow(SignInError);
    });

    it("rejects a URL that only contains the redirect URI", () => {
        expect(() => parseAuthorizeResponse(`neore-mobile://evil/${REDIRECT}?code=abc&state=s1`, input)).toThrow("unexpected address");
        expect(() => parseAuthorizeResponse(`${REDIRECT}x?code=abc&state=s1`, input)).toThrow("unexpected address");
    });

    it("reports a declined grant and a missing code", () => {
        expect(() => parseAuthorizeResponse(`${REDIRECT}?error=access_denied&state=s1`, input)).toThrow("declined");
        expect(() => parseAuthorizeResponse(`${REDIRECT}?state=s1`, input)).toThrow("did not return a code");
    });

    it("reports a malformed escape as a sign-in error, not a URIError", () => {
        expect(() => parseAuthorizeResponse(`${REDIRECT}?code=100%&state=s1`, input)).toThrow(SignInError);
        expect(() => parseAuthorizeResponse(`${REDIRECT}?code=100%&state=s1`, input)).toThrow("unreadable");
    });

    it("treats a missing URL as a cancelled sign-in", () => {
        expect(() => parseAuthorizeResponse(undefined, input)).toThrow("cancelled");
    });
});

describe("buildAuthorizeUrl", () => {
    it("encodes the redirect URI into the query", () => {
        const url = buildAuthorizeUrl({ appUrl: "https://app.example/", challenge: "c", redirectUri: REDIRECT, state: "s" });

        expect(url).toBe("https://app.example/auth/extension?code_challenge=c&redirect_uri=neore-mobile%3A%2F%2Fauth%2Fcallback&state=s");
    });
});

describe("grant storage", () => {
    it("exchange stores only the session token and user", async () => {
        const store = memoryStore();
        const seen: unknown[] = [];
        const fetch: Fetch = async (url, init) => {
            seen.push({ body: JSON.parse(String(init?.body)), credentials: init?.credentials, url });

            return json({ token: "session-1", user: USER });
        };

        const user = await exchangeGrant({ code: "code-1", fetch, lunoraUrl: LUNORA, redirectUri: REDIRECT, store, verifier: "v" });

        expect(user).toEqual(USER);
        expect(store.value).toEqual({ token: "session-1", user: USER });
        expect(seen).toEqual([
            {
                body: { code: "code-1", codeVerifier: "v", redirectUri: REDIRECT },
                credentials: "omit",
                url: `${LUNORA}/extension/auth/exchange`,
            },
        ]);
    });

    it("a refused exchange stores nothing and surfaces the server message", async () => {
        const store = memoryStore();
        const fetch: Fetch = async () => json({ message: "Code expired." }, 400);

        await expect(exchangeGrant({ code: "c", fetch, lunoraUrl: LUNORA, redirectUri: REDIRECT, store, verifier: "v" })).rejects.toThrow("Code expired.");
        expect(store.value).toBeNull();
    });

    it.each([
        ["no token", { user: USER }],
        ["an empty token", { token: "", user: USER }],
        ["a non-string token", { token: 7, user: USER }],
        ["no user", { token: "session-1" }],
        ["a user without an id", { token: "session-1", user: { name: "A" } }],
        ["a null body", null],
    ])("a 200 with %s stores nothing", async (_name, body) => {
        const store = memoryStore();
        const fetch: Fetch = async () => json(body);

        await expect(exchangeGrant({ code: "c", fetch, lunoraUrl: LUNORA, redirectUri: REDIRECT, store, verifier: "v" })).rejects.toThrow(
            "Sign-in failed. Try again.",
        );
        expect(store.value).toBeNull();
    });

    it("an exchange that never answers times out, stores nothing and says so", async () => {
        vi.useFakeTimers();

        try {
            const store = memoryStore();
            const fetch: Fetch = (_url, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                });

            const pending = exchangeGrant({ code: "c", fetch, lunoraUrl: LUNORA, redirectUri: REDIRECT, store, verifier: "v" });
            const failure = expect(pending).rejects.toThrow("Sign-in timed out. Try again.");

            await vi.advanceTimersByTimeAsync(15_000);
            await failure;
            expect(store.value).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("a 401 from the token route clears the grant", async () => {
        const store = memoryStore({ token: "session-1", user: USER });
        const fetch: Fetch = async () => json({ error: "invalid_token" }, 401);

        expect(await fetchAccessToken({ fetch, lunoraUrl: LUNORA, store })).toBeNull();
        expect(store.value).toBeNull();
    });

    it("a 403 from the token route clears the grant: the account is refused, not the network", async () => {
        const store = memoryStore({ token: "session-1", user: USER });
        const fetch: Fetch = async () => json({ error: "access_denied" }, 403);

        expect(await fetchAccessToken({ fetch, lunoraUrl: LUNORA, store })).toBeNull();
        expect(store.value).toBeNull();
    });

    it("a 500 from the token route throws and keeps the grant", async () => {
        const store = memoryStore({ token: "session-1", user: USER });
        const fetch: Fetch = async () => json({ error: "server_error" }, 500);

        await expect(fetchAccessToken({ fetch, lunoraUrl: LUNORA, store })).rejects.toThrow("Could not reach the server.");
        expect(store.value).toEqual({ token: "session-1", user: USER });
    });

    it("returns the JWT and sends the session token in the body only", async () => {
        const store = memoryStore({ token: "session-1", user: USER });
        let sent: unknown;
        const fetch: Fetch = async (_url, init) => {
            sent = JSON.parse(String(init?.body));

            return json({ token: "jwt-1", user: USER });
        };

        expect(await fetchAccessToken({ fetch, lunoraUrl: LUNORA, store })).toBe("jwt-1");
        expect(sent).toEqual({ token: "session-1" });
    });
});

describe("takeStoredGrant", () => {
    it("clears the stored session and resolves its token, so the caller can revoke it", async () => {
        const store = memoryStore({ token: "session-1", user: USER });

        expect(await takeStoredGrant(store)).toBe("session-1");
        expect(store.value).toBeNull();
    });

    it("resolves nothing when no session was stored", async () => {
        expect(await takeStoredGrant(memoryStore())).toBeUndefined();
    });

    it("carries the token it read when the stored session cannot be cleared, so the session can still be revoked", async () => {
        const store: GrantStore = {
            clear: async () => {
                throw new Error("keychain locked");
            },
            get: async () => {
                return { token: "session-1", user: USER };
            },
            set: async () => {},
        };

        await expect(takeStoredGrant(store)).rejects.toMatchObject({ name: "StoredGrantNotClearedError", token: "session-1" });
    });

    it("still clears the stored session when it cannot be read, so an unreadable sign-in is removed", async () => {
        const clear = vi.fn(async () => undefined);
        const store: GrantStore = {
            clear,
            get: async () => {
                throw new Error("keychain locked");
            },
            set: async () => {},
        };

        await expect(takeStoredGrant(store)).resolves.toBeUndefined();
        expect(clear).toHaveBeenCalledOnce();
    });
});

describe("revokeSessionToken", () => {
    it("revokes the token it is given", async () => {
        const sent: unknown[] = [];
        const fetch: Fetch = async (_url, init) => {
            sent.push(JSON.parse(String(init?.body)));

            return json({});
        };

        await revokeSessionToken({ fetch, lunoraUrl: LUNORA, token: "session-1" });

        expect(sent).toEqual([{ token: "session-1" }]);
    });

    it("rejects when the server cannot be reached, so the caller can tell the revoke did not happen", async () => {
        const fetch: Fetch = async () => {
            throw new Error("offline");
        };

        await expect(revokeSessionToken({ fetch, lunoraUrl: LUNORA, token: "session-1" })).rejects.toThrow("offline");
    });

    it("rejects when the server refuses the revoke, so a refused revoke is not reported as done", async () => {
        const fetch: Fetch = async () => json({ message: "nope" }, 500);

        await expect(revokeSessionToken({ fetch, lunoraUrl: LUNORA, token: "session-1" })).rejects.toThrow("Could not revoke the session (500).");
    });
});

describe("randomness", () => {
    it("produces distinct states", async () => {
        const dependencies = {
            digestBase64: async () => "AAAA",
            randomBytes: (count: number) => new Uint8Array(randomBytes(count)),
        };
        const a = await createPkce(dependencies);
        const b = await createPkce(dependencies);

        expect(a.state).not.toBe(b.state);
    });
});

describe("readStoredUser", () => {
    it("returns the stored user", async () => {
        expect(await readStoredUser(memoryStore({ token: "t", user: USER }))).toEqual(USER);
    });

    it("returns null when nothing is stored", async () => {
        expect(await readStoredUser(memoryStore())).toBeNull();
    });

    it("returns null instead of rejecting when the store cannot be read", async () => {
        const store = { ...memoryStore(), get: async (): Promise<StoredGrant | null> => {
            throw new Error("store locked");
        } };

        expect(await readStoredUser(store)).toBeNull();
    });
});
