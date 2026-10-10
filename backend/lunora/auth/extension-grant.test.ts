import { describe, expect, it } from "vitest";

import type { ExtensionGrantStore, ExtensionGrantUser } from "./extension-grant";
import { authorizeExtension, CODE_TTL_MS, exchangeExtensionCode, mintExtensionAccessToken, pkceChallenge, revokeExtensionSession } from "./extension-grant";

const REDIRECT_URI = `https://${"a1".repeat(20)}.extensions.allizom.org/`;
const OTHER_REDIRECT_URI = `https://${"b2".repeat(20)}.extensions.allizom.org/`;
const VERIFIER = `${"v".repeat(20)}-._~${"x".repeat(40)}`;
const CODE_SHAPE = /^[\w-]{43}$/;
const ORIGIN = "https://api.example.test";

const USER: ExtensionGrantUser = { email: "ada@example.test", id: "user-1", image: null, isAnonymous: false, name: "Ada", role: "user" };

/**
 * An in-memory `ExtensionGrantStore`.
 *
 * `consumeCode` deletes-and-returns like better-auth's `consumeVerificationValue`,
 * but deliberately does NOT filter expired rows — so the expiry test proves the
 * flow's own check, not the store's.
 */
const createStore = (users: ExtensionGrantUser[] = [USER]) => {
    const codes = new Map<string, { expiresAt: Date; value: string }>();
    const sessions = new Map<string, { expiresAt: Date; userId: string }>();
    const signed: Record<string, unknown>[] = [];
    let sessionCount = 0;

    const store: ExtensionGrantStore = {
        consumeCode: async (identifier) => {
            const row = codes.get(identifier) ?? null;

            codes.delete(identifier);

            return row;
        },
        createSession: async (userId) => {
            sessionCount += 1;

            const session = { expiresAt: new Date(Date.now() + 7 * 86_400_000), token: `session-${sessionCount}` };

            sessions.set(session.token, { expiresAt: session.expiresAt, userId });

            return session;
        },
        deleteSession: async (token) => {
            sessions.delete(token);
        },
        extendSession: async (token, expiresAt) => {
            const session = sessions.get(token);

            if (session) {
                session.expiresAt = expiresAt;
            }
        },
        findSession: async (token) => {
            const session = sessions.get(token);
            const user = users.find((candidate) => candidate.id === session?.userId);

            return session && user ? { session: { expiresAt: session.expiresAt }, user } : null;
        },
        findUser: async (userId) => users.find((candidate) => candidate.id === userId) ?? null,
        saveCode: async (identifier, value, expiresAt) => {
            codes.set(identifier, { expiresAt, value });
        },
        signJwt: async (payload) => {
            signed.push(payload);

            return `jwt-${signed.length}`;
        },
    };

    return { codes, sessions, signed, store };
};

const authorize = async (store: ExtensionGrantStore, overrides: Partial<Parameters<typeof authorizeExtension>[1]> = {}) =>
    await authorizeExtension(store, {
        codeChallenge: await pkceChallenge(VERIFIER),
        redirectUri: REDIRECT_URI,
        trustedRedirectUris: [REDIRECT_URI],
        userId: USER.id,
        ...overrides,
    });

describe("pkceChallenge", () => {
    it("matches the RFC 7636 Appendix B example", async () => {
        await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });
});

describe("authorizeExtension", () => {
    it("stores a hash of the code, never the code itself", async () => {
        const { codes, store } = createStore();
        const { code, expiresAt } = await authorize(store, { now: 1000 });

        expect(code).toMatch(CODE_SHAPE);
        expect(expiresAt).toBe(1000 + CODE_TTL_MS);
        expect([...codes.keys()]).toHaveLength(1);
        expect([...codes.keys()][0]).not.toContain(code);
        expect(JSON.stringify([...codes.values()])).not.toContain(code);
    });

    it("refuses a redirect URI that is not on the trusted list", async () => {
        const { codes, store } = createStore();

        await expect(authorize(store, { redirectUri: "https://evil.example/" })).rejects.toMatchObject({
            code: "invalid_request",
            name: "ExtensionGrantError",
        });
        await expect(authorize(store, { trustedRedirectUris: [] })).rejects.toMatchObject({ code: "invalid_request", name: "ExtensionGrantError" });
        expect(codes.size).toBe(0);
    });

    it("refuses a missing caller, a guest, a banned user and a malformed challenge", async () => {
        const { store } = createStore([USER, { ...USER, id: "guest", isAnonymous: true }, { ...USER, banned: true, id: "banned" }]);

        await expect(authorize(store, { userId: null })).rejects.toMatchObject({ code: "unauthorized", name: "ExtensionGrantError" });
        await expect(authorize(store, { userId: "guest" })).rejects.toMatchObject({ code: "access_denied", name: "ExtensionGrantError" });
        await expect(authorize(store, { userId: "banned" })).rejects.toMatchObject({ code: "access_denied", name: "ExtensionGrantError" });
        await expect(authorize(store, { codeChallenge: "plain-verifier" })).rejects.toMatchObject({ code: "invalid_request", name: "ExtensionGrantError" });
    });
});

describe("exchangeExtensionCode", () => {
    it("issues a session for the approving user", async () => {
        const { sessions, store } = createStore();
        const { code } = await authorize(store);
        const result = await exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI });

        expect(result.user).toEqual({ email: USER.email, id: USER.id, image: null, name: USER.name });
        expect(sessions.get(result.token)?.userId).toBe(USER.id);
    });

    it("is single use: a replayed code fails even with the right verifier", async () => {
        const { sessions, store } = createStore();
        const { code } = await authorize(store);

        await exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI });
        await expect(exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
        expect(sessions.size).toBe(1);
    });

    it("rejects an expired code", async () => {
        const { sessions, store } = createStore();
        const { code } = await authorize(store, { now: 0 });

        await expect(exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, now: CODE_TTL_MS, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
        expect(sessions.size).toBe(0);
    });

    it("rejects a verifier that does not hash to the challenge, and burns the code", async () => {
        const { sessions, store } = createStore();
        const { code } = await authorize(store);

        await expect(exchangeExtensionCode(store, { code, codeVerifier: "w".repeat(64), redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
        // The right verifier no longer helps: one failed try consumed it.
        await expect(exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
        expect(sessions.size).toBe(0);
    });

    it("rejects a redirect URI other than the one the code was issued for", async () => {
        const { store } = createStore();
        const { code } = await authorize(store, { trustedRedirectUris: [REDIRECT_URI, OTHER_REDIRECT_URI] });

        await expect(exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: OTHER_REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
    });

    it("rejects an unknown or malformed code without touching the store", async () => {
        const { store } = createStore();

        await expect(exchangeExtensionCode(store, { code: "x".repeat(43), codeVerifier: VERIFIER, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
        await expect(exchangeExtensionCode(store, { code: "not a code", codeVerifier: VERIFIER, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "invalid_grant",
            name: "ExtensionGrantError",
        });
    });

    it("re-checks the user: banned between approval and exchange means no session", async () => {
        const users = [{ ...USER }];
        const { sessions, store } = createStore(users);
        const { code } = await authorize(store);

        users[0]!.banned = true;

        await expect(exchangeExtensionCode(store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI })).rejects.toMatchObject({
            code: "access_denied",
            name: "ExtensionGrantError",
        });
        expect(sessions.size).toBe(0);
    });
});

describe("mintExtensionAccessToken", () => {
    const signIn = async () => {
        const context = createStore();
        const { code } = await authorize(context.store);
        const { token } = await exchangeExtensionCode(context.store, { code, codeVerifier: VERIFIER, redirectUri: REDIRECT_URI });

        return { ...context, token };
    };

    it("signs the session user with iss/aud pinned to the backend origin", async () => {
        const { signed, store, token } = await signIn();
        const result = await mintExtensionAccessToken(store, { now: 5_000_000, origin: ORIGIN, token });

        expect(result.token).toBe("jwt-1");
        expect(signed[0]).toMatchObject({ aud: ORIGIN, email: USER.email, iat: 5000, iss: ORIGIN, sub: USER.id });
    });

    it("rejects an unknown, expired or revoked session", async () => {
        const { sessions, store, token } = await signIn();

        await expect(mintExtensionAccessToken(store, { origin: ORIGIN, token: "nope" })).rejects.toMatchObject({
            code: "invalid_token",
            name: "ExtensionGrantError",
        });
        await expect(mintExtensionAccessToken(store, { now: sessions.get(token)!.expiresAt.getTime(), origin: ORIGIN, token })).rejects.toMatchObject({
            code: "invalid_token",
            name: "ExtensionGrantError",
        });

        await revokeExtensionSession(store, token);
        await expect(mintExtensionAccessToken(store, { origin: ORIGIN, token })).rejects.toMatchObject({ code: "invalid_token", name: "ExtensionGrantError" });
    });

    it("slides the session forward once it is a day old", async () => {
        const { sessions, store, token } = await signIn();
        const issuedExpiry = sessions.get(token)!.expiresAt.getTime();

        await mintExtensionAccessToken(store, { origin: ORIGIN, token });
        expect(sessions.get(token)!.expiresAt.getTime()).toBe(issuedExpiry);

        const twoDaysLater = Date.now() + 2 * 86_400_000;

        await mintExtensionAccessToken(store, { now: twoDaysLater, origin: ORIGIN, token });
        expect(sessions.get(token)!.expiresAt.getTime()).toBe(twoDaysLater + 7 * 86_400_000);
    });
});
