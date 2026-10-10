/**
 * Sign-in for browser extensions that cannot share the web app's cookies.
 *
 * Firefox gives every install its own random `moz-extension://<uuid>` origin, so
 * the Chrome build's model — trust the extension's exact origin for credentialed
 * CORS (`TRUSTED_EXTENSION_ORIGINS`) — has no single origin to list. It does not
 * need one: an extension page holding `host_permissions` for the backend is not
 * subject to CORS at all (MDN, `host_permissions`: "XMLHttpRequest and fetch
 * access to those origins without cross-origin restrictions"), and every check
 * that looks at the `Origin` header here — better-auth's origin check, Lunora's
 * CSRF and WebSocket checks — only runs for requests that carry a cookie. So the
 * Firefox build sends NO cookies, only bearer tokens, and nothing needs to
 * recognise its origin.
 *
 * What it needs instead is a way to obtain a token. This is an authorization-code
 * flow with PKCE (RFC 7636), run through `identity.launchWebAuthFlow`:
 *
 * 1. The extension generates a `code_verifier`, and opens the web app's
 *    `/auth/extension` page with `code_challenge = BASE64URL(SHA-256(verifier))`
 *    and `redirect_uri = identity.getRedirectURL()`.
 * 2. The user signs in there however they like (password, Google, passkey…) and
 *    approves. The page calls `authorizeExtension` below as that user, which
 *    stores a single-use code bound to the user, the challenge and the redirect
 *    URI for `CODE_TTL_MS`, and navigates to `redirect_uri?code=…`. The browser
 *    intercepts that navigation and hands the URL to the extension unloaded.
 * 3. The extension posts `{ code, code_verifier, redirect_uri }` to
 *    `exchangeExtensionCode`, which consumes the code ATOMICALLY (a replay gets
 *    `null`), checks it has not expired, that the redirect URI is the one it was
 *    issued for and that the verifier hashes to the challenge — and only then
 *    creates a better-auth session for the user and returns its token.
 *
 * The code is the only secret that ever appears in a URL, it is useless without
 * the verifier (which never leaves the extension), it dies after one use or a
 * minute, and a failed exchange burns it. The redirect URI must be on the
 * `TRUSTED_EXTENSION_REDIRECT_URIS` list. The extension URIs there are
 * intercepted by the browser for the ONE extension whose id they derive from,
 * so no web page can receive a code. The one exception is the native shell's
 * opt-in `neore://auth/callback` (`NATIVE_REDIRECT_URI`): any local app can
 * register a custom scheme, so for it the PKCE verifier is the ONLY protection
 * (RFC 8252 §7.1) — never relax that check or the consume-before-check order
 * below. Its codes become a cookie session, never a token, through
 * `client-grant-cookie.ts`, which accepts no other redirect URI.
 *
 * The session token is the extension's long-lived grant. It is a real
 * better-auth session — it shows up in the user's session list and revoking it
 * there signs the extension out — but it is never sent as a cookie: the
 * extension trades it at `mintExtensionAccessToken` for the same short-lived JWT
 * the web app gets from `/api/auth/token`, and uses that as a bearer everywhere.
 *
 * This module is pure over `ExtensionGrantStore` so the security properties
 * (expiry, replay, verifier mismatch) are unit-tested without a worker;
 * `createExtensionGrantStore` binds it to the real better-auth instance.
 */
import { sha256Bytes, timingSafeEqual } from "../lib/crypto";

/** How long a code lives. It only has to survive one redirect and one POST. */
export const CODE_TTL_MS = 60_000;

/** Slide the session forward once it is older than this — better-auth's own `updateAge` default. */
const SESSION_UPDATE_AGE_MS = 24 * 60 * 60 * 1000;

/** better-auth's default `session.expiresIn`, which is what `createSession` applies. */
const SESSION_TTL_MS = 7 * SESSION_UPDATE_AGE_MS;

/** `verification.identifier` prefix, so these rows cannot collide with better-auth's own. */
const IDENTIFIER_PREFIX = "extension-auth:";

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. */
const CODE_VERIFIER = /^[\w.~-]{43,128}$/;

/** BASE64URL(SHA-256(...)) without padding is always 43 characters. */
const CODE_CHALLENGE = /^[\w-]{43}$/;

/** A code as `randomCode` makes it: 32 random bytes, base64url. */
const CODE = /^[\w-]{43}$/;

export interface ExtensionGrantUser {
    [key: string]: unknown;
    banned?: boolean | null;
    email: string;
    id: string;
    image?: string | null;
    isAnonymous?: boolean | null;
    name: string;
}

/** The slice of better-auth this flow uses. */
export interface ExtensionGrantStore {
    /** Atomically delete and return the code row; `null` when absent or already consumed. */
    consumeCode: (identifier: string) => Promise<null | { expiresAt: Date; value: string }>;
    createSession: (userId: string, meta: { ipAddress?: string; userAgent?: string }) => Promise<{ expiresAt: Date; token: string }>;
    deleteSession: (token: string) => Promise<void>;
    extendSession: (token: string, expiresAt: Date) => Promise<void>;
    findSession: (token: string) => Promise<null | { session: { expiresAt: Date }; user: ExtensionGrantUser }>;
    findUser: (userId: string) => Promise<ExtensionGrantUser | null>;
    saveCode: (identifier: string, value: string, expiresAt: Date) => Promise<void>;
    /** Sign a JWT with better-auth's JWKS; `iss`/`aud` are already in the payload. */
    signJwt: (payload: Record<string, unknown>) => Promise<string>;
}

export type ExtensionGrantErrorCode = "access_denied" | "invalid_grant" | "invalid_request" | "invalid_token" | "unauthorized";

export class ExtensionGrantError extends Error {
    public readonly code: ExtensionGrantErrorCode;

    public constructor(code: ExtensionGrantErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = "ExtensionGrantError";
    }

    /** HTTP status for the error, OAuth-style: 401 for a bad credential, 403 for a refused user, else 400. */
    public get status(): 400 | 401 | 403 {
        if (this.code === "unauthorized" || this.code === "invalid_token") {
            return 401;
        }

        return this.code === "access_denied" ? 403 : 400;
    }
}

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    let encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_");

    // Unpadded (RFC 7636 §3), trimmed by hand rather than with an anchored
    // quantifier regex.
    while (encoded.endsWith("=")) {
        encoded = encoded.slice(0, -1);
    }

    return encoded;
};

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export const pkceChallenge = async (verifier: string): Promise<string> => toBase64Url(await sha256Bytes(verifier));

/**
 * The stored identifier is a HASH of the code, so a database read (a backup, the
 * admin studio) never yields a usable code.
 */
const codeIdentifier = async (code: string): Promise<string> => `${IDENTIFIER_PREFIX}${toBase64Url(await sha256Bytes(code))}`;

const randomCode = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

interface StoredCode {
    codeChallenge: string;
    redirectUri: string;
    userId: string;
}

const parseStoredCode = (value: string): StoredCode | undefined => {
    try {
        const parsed = JSON.parse(value) as Partial<StoredCode>;

        return typeof parsed.userId === "string" && typeof parsed.codeChallenge === "string" && typeof parsed.redirectUri === "string"
            ? (parsed as StoredCode)
            : undefined;
    } catch {
        return undefined;
    }
};

/** The profile fields the extension shows; never the whole user row. */
export interface ExtensionGrantProfile {
    email: string;
    id: string;
    image: string | null;
    name: string;
}

const profileOf = (user: ExtensionGrantUser): ExtensionGrantProfile => {
    return { email: user.email, id: user.id, image: user.image ?? null, name: user.name };
};

/** A user the extension may act for: signed up (not a guest) and not banned. */
const assertEligible = (user: ExtensionGrantUser | null): ExtensionGrantUser => {
    if (!user) {
        throw new ExtensionGrantError("unauthorized", "Not signed in.");
    }

    if (user.isAnonymous) {
        throw new ExtensionGrantError("access_denied", "Guest accounts cannot connect the extension. Sign in with your account first.");
    }

    if (user.banned) {
        throw new ExtensionGrantError("access_denied", "This account is suspended.");
    }

    return user;
};

/**
 * Step 2: mint a single-use code for the signed-in `userId`.
 *
 * `trustedRedirectUris` is the parsed `TRUSTED_EXTENSION_REDIRECT_URIS`, compared
 * exactly — the check that keeps a code from being delivered anywhere but an
 * extension the operator listed.
 */
export const authorizeExtension = async (
    store: ExtensionGrantStore,
    input: { codeChallenge: string; now?: number; redirectUri: string; trustedRedirectUris: ReadonlyArray<string>; userId: null | string | undefined },
): Promise<{ code: string; expiresAt: number }> => {
    if (!input.userId) {
        throw new ExtensionGrantError("unauthorized", "Not signed in.");
    }

    if (!input.trustedRedirectUris.includes(input.redirectUri)) {
        throw new ExtensionGrantError("invalid_request", "This extension is not allowed to sign in here.");
    }

    if (!CODE_CHALLENGE.test(input.codeChallenge)) {
        throw new ExtensionGrantError("invalid_request", "code_challenge must be BASE64URL(SHA-256(code_verifier)).");
    }

    assertEligible(await store.findUser(input.userId));

    const code = randomCode();
    const expiresAt = (input.now ?? Date.now()) + CODE_TTL_MS;
    const value: StoredCode = { codeChallenge: input.codeChallenge, redirectUri: input.redirectUri, userId: input.userId };

    await store.saveCode(await codeIdentifier(code), JSON.stringify(value), new Date(expiresAt));

    return { code, expiresAt };
};

/**
 * Step 3: trade a code plus its verifier for a session token.
 *
 * The code is consumed BEFORE anything is checked, so every failure — wrong
 * verifier, wrong redirect URI, expired — also burns it; a guessed verifier gets
 * exactly one try. Every failure is the same `invalid_grant`, so a caller learns
 * nothing about which check failed.
 */
export const exchangeExtensionCode = async (
    store: ExtensionGrantStore,
    input: { code: string; codeVerifier: string; ipAddress?: string; now?: number; redirectUri: string; userAgent?: string },
): Promise<{ expiresAt: number; token: string; user: ExtensionGrantProfile }> => {
    const invalid = new ExtensionGrantError("invalid_grant", "The sign-in code is invalid or has expired. Try signing in again.");

    if (!CODE.test(input.code)) {
        throw invalid;
    }

    const row = await store.consumeCode(await codeIdentifier(input.code));

    if (!row || row.expiresAt.getTime() <= (input.now ?? Date.now())) {
        throw invalid;
    }

    const stored = parseStoredCode(row.value);

    if (!stored || !timingSafeEqual(stored.redirectUri, input.redirectUri) || !CODE_VERIFIER.test(input.codeVerifier)) {
        throw invalid;
    }

    if (!timingSafeEqual(await pkceChallenge(input.codeVerifier), stored.codeChallenge)) {
        throw invalid;
    }

    // Re-checked: the user could have been banned in the minute since approving.
    const user = assertEligible(await store.findUser(stored.userId));
    const session = await store.createSession(user.id, { ipAddress: input.ipAddress, userAgent: input.userAgent });

    return { expiresAt: session.expiresAt.getTime(), token: session.token, user: profileOf(user) };
};

/**
 * Trade the extension's session token for a short-lived JWT.
 *
 * The payload is what better-auth's `/token` endpoint signs by default — the
 * session's user, `sub` = user id — with `iss`/`aud` pinned to `origin`, because
 * `server.ts` verifies bearer tokens against exactly that and a server-side
 * `signJWT` would otherwise fall back to `SITE_URL`. The session slides forward
 * the way better-auth's own `getSession` would slide a cookie session.
 */
export const mintExtensionAccessToken = async (
    store: ExtensionGrantStore,
    input: { now?: number; origin: string; token: string },
): Promise<{ token: string; user: ExtensionGrantProfile }> => {
    const now = input.now ?? Date.now();
    const found = input.token ? await store.findSession(input.token) : null;

    if (!found || found.session.expiresAt.getTime() <= now) {
        throw new ExtensionGrantError("invalid_token", "The extension's session has ended. Sign in again.");
    }

    const user = assertEligible(found.user);

    if (found.session.expiresAt.getTime() - now < SESSION_TTL_MS - SESSION_UPDATE_AGE_MS) {
        await store.extendSession(input.token, new Date(now + SESSION_TTL_MS));
    }

    const token = await store.signJwt({
        iat: Math.floor(now / 1000),
        ...user,
        aud: input.origin,
        iss: input.origin,
        sub: user.id,
    });

    return { token, user: profileOf(user) };
};

/** Sign out: delete the session. Idempotent — an unknown token is not an error. */
export const revokeExtensionSession = async (store: ExtensionGrantStore, token: string): Promise<void> => {
    if (token) {
        await store.deleteSession(token);
    }
};

/**
 * The better-auth instance's internal adapter and JWT signer, as far as this
 * flow needs them.
 *
 * Structural rather than `ReturnType<typeof createAuth>`: the options are typed
 * `BetterAuthOptions`, so plugin endpoints like `signJWT` never reach the
 * instance's static type — they exist at runtime because `auth.ts` installs
 * `jwt()`, which `auth.plugins.test.ts` pins.
 */
interface BetterAuthLike {
    $context: Promise<{
        internalAdapter: {
            consumeVerificationValue: (identifier: string) => Promise<null | { expiresAt: Date; value: string }>;
            createSession: (userId: string, dontRememberMe?: boolean, override?: Record<string, unknown>) => Promise<{ expiresAt: Date; token: string }>;
            createVerificationValue: (data: { expiresAt: Date; identifier: string; value: string }) => Promise<unknown>;
            deleteSession: (token: string) => Promise<void>;
            findSession: (token: string) => Promise<null | { session: { expiresAt: Date }; user: ExtensionGrantUser }>;
            findUserById: (userId: string) => Promise<ExtensionGrantUser | null>;
            updateSession: (token: string, session: { expiresAt: Date }) => Promise<unknown>;
        };
    }>;
    api: unknown;
}

type SignJwtEndpoint = (input: { body: { payload: Record<string, unknown> } }) => Promise<{ token: string }>;

export const createExtensionGrantStore = (auth: unknown): ExtensionGrantStore => {
    const instance = auth as BetterAuthLike;
    const adapter = async () => {
        const context = await instance.$context;

        return context.internalAdapter;
    };

    return {
        consumeCode: async (identifier) => {
            const internal = await adapter();

            return await internal.consumeVerificationValue(identifier);
        },
        createSession: async (userId, meta) => {
            const internal = await adapter();
            const session = await internal.createSession(userId, false, {
                ...(meta.ipAddress && { ipAddress: meta.ipAddress }),
                ...(meta.userAgent && { userAgent: meta.userAgent }),
            });

            return { expiresAt: session.expiresAt, token: session.token };
        },
        deleteSession: async (token) => {
            const internal = await adapter();

            await internal.deleteSession(token);
        },
        extendSession: async (token, expiresAt) => {
            const internal = await adapter();

            await internal.updateSession(token, { expiresAt });
        },
        findSession: async (token) => {
            const internal = await adapter();

            return await internal.findSession(token);
        },
        findUser: async (userId) => {
            const internal = await adapter();

            return await internal.findUserById(userId);
        },
        saveCode: async (identifier, value, expiresAt) => {
            const internal = await adapter();

            await internal.createVerificationValue({ expiresAt, identifier, value });
        },
        signJwt: async (payload) => {
            const signJwt = (instance.api as { signJWT?: SignJwtEndpoint }).signJWT;

            if (!signJwt) {
                throw new Error("better-auth's jwt() plugin is not installed — the extension cannot be issued tokens.");
            }

            const { token } = await signJwt({ body: { payload } });

            return token;
        },
    };
};
