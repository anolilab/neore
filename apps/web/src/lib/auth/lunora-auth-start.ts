import { LunoraClient } from "@lunora/client";
import type { ArgsOf, FunctionReference, ReturnOf } from "@lunora/react";
import React from "react";

import type { SessionAuthStatus } from "./session-read";
import { isRetryableStatus } from "./session-read";

/**
 * Deadline for one proxied auth call. Without one a single stuck upstream
 * connection hung the request forever (a `has-permission` call never answered,
 * another took 122s). Auth endpoints answer in milliseconds; 30s only bounds a
 * wedged connection. The BROWSER's abort signal is deliberately not forwarded —
 * an abandoned request mid-write was a `wrangler dev` crash trigger (CLAUDE.md).
 */
const AUTH_PROXY_TIMEOUT_MS = 30_000;

const COOKIE_VALUE_RE = /=(.*)/s;

/**
 * Lunora's `OptionalRestArgs&lt;F>` — the args as a rest tuple. `@lunora/react` has
 * `ArgsOf&lt;F>` (the args OBJECT) but no tuple form, and these three fetchers are
 * spread-called, so the tuple is what they need.
 */
type OptionalRestArgs<F> = [args: ArgsOf<F>];

/**
 * Server-side auth helpers for Lunora with TanStack Start:
 * - JWT token fetching with cookie caching
 * - HTTP proxy handler for auth endpoints
 * - Authenticated Lunora query/mutation/action calls
 */

/** better-auth's session cookie, under this app's `cookiePrefix` (see `backend/lunora/auth.ts`). */
const SESSION_COOKIE_NAME = "session_token";
const SECURE_COOKIE_PREFIX = "__Secure-";

/** Hard ceiling on a cached token's life, independent of its `exp`. */
const TOKEN_CACHE_MAX_AGE_SECONDS = 60;
/** Cap on the number of concurrent sessions kept in memory. */
const TOKEN_CACHE_MAX_ENTRIES = 200;

/**
 * Server-process cache of issued JWTs, keyed by the session cookie that earned
 * them.
 *
 * The root route's `beforeLoad` calls `getSessionToken()` on EVERY navigation,
 * and each call used to mint a fresh JWT on the backend — that path has already
 * hammered `/api/auth/token` into rate-limiting once.
 *
 * The cookie cache this replaces read a `&lt;prefix>.lunora_jwt` cookie that
 * nothing ever wrote, so it could not hit. Writing it for real would mean
 * handing the browser a second bearer token with its own expiry, and — worse —
 * one that better-auth does not clear on sign-out, so a signed-out browser
 * would keep presenting a valid token until the JWT expired. Keeping the token
 * server-side sidesteps both: the key IS the session cookie, so a sign-out, a
 * different user, or an anonymous->real upgrade all miss by construction, and
 * nothing new is exposed to the client.
 *
 * Per isolate/process, so a multi-instance deployment simply warms more than
 * one cache.
 */
const tokenCache = new Map<string, { expiresAt: number; token: string }>();

/**
 * Seconds a last-known token must still have before its JWT `exp` to stand in
 * for a failed fetch. Past that the backend would reject it anyway.
 */
const LAST_KNOWN_TOKEN_MARGIN_SECONDS = 10;

const nowSeconds = () => Math.floor(Date.now() / 1000);

export type GetTokenOptions = {
    cookiePrefix?: string;
    forceRefresh?: boolean;
    jwtCache?: {
        enabled: boolean;
        expirationToleranceSeconds?: number;
        isAuthError: (error: unknown) => boolean;
    };
};

type ClientOptions = {
    lunoraSiteUrl: string;
    lunoraUrl: string;
    token?: string;
};

const parseCookies = (cookieHeader: string): Map<string, string> => {
    const cookies = cookieHeader.split("; ");
    const cookieMap = new Map<string, string>();

    for (const cookie of cookies) {
        const [name, value] = cookie.split(COOKIE_VALUE_RE, 2);

        if (name) {
            cookieMap.set(name, value ?? "");
        }
    }

    return cookieMap;
};

const getSessionCookie = (headers: Headers, config: { cookieName: string; cookiePrefix?: string }): string | null => {
    const cookies = headers.get("cookie");

    if (!cookies) {
        return null;
    }

    const { cookieName, cookiePrefix = "better-auth" } = config;
    const parsed = parseCookies(cookies);
    const getCookie = (name: string) => parsed.get(name) ?? parsed.get(`${SECURE_COOKIE_PREFIX}${name}`) ?? null;

    return getCookie(`${cookiePrefix}.${cookieName}`) ?? getCookie(`${cookiePrefix}-${cookieName}`);
};

const decodeJwtPayload = (token: string): { exp?: number } => {
    const parts = token.split(".");

    if (parts.length !== 3 || !parts[1]) {
        return {};
    }

    const base64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");

    try {
        const json = atob(base64);

        return JSON.parse(json) as { exp?: number };
    } catch {
        return {};
    }
};

/**
 * Seconds-since-epoch at which a cached copy of this token must stop being used.
 *
 * Refresh EARLY, not late. `exp + tolerance` treated a token as fresh for a
 * minute AFTER it expired, and the backend verifies with jose's default
 * `clockTolerance: 0` — so those tokens are rejected server-side.
 */
export const cacheExpiryFor = (token: string, toleranceSeconds: number): number => {
    const { exp } = decodeJwtPayload(token);

    if (!exp) {
        // No expiry claim means no idea when it dies: don't cache it.
        return 0;
    }

    return Math.min(exp - toleranceSeconds, nowSeconds() + TOKEN_CACHE_MAX_AGE_SECONDS);
};

const rememberToken = (key: string, token: string, toleranceSeconds: number) => {
    const expiresAt = cacheExpiryFor(token, toleranceSeconds);

    if (expiresAt <= nowSeconds()) {
        return;
    }

    // Insertion order = age. Evict the oldest rather than grow without bound.
    while (tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
        const oldest = tokenCache.keys().next().value;

        if (oldest === undefined) {
            break;
        }

        tokenCache.delete(oldest);
    }

    // Re-inserted, so a refreshed session counts as the newest entry.
    tokenCache.delete(key);
    tokenCache.set(key, { expiresAt, token });
};

/**
 * A cached token for this session that the backend would still accept, even
 * though its cache slot has lapsed — the "last known session" a failed fetch
 * falls back to.
 */
const lastKnownToken = (cacheKey: string | undefined): string | undefined => {
    const entry = cacheKey === undefined ? undefined : tokenCache.get(cacheKey);

    if (!entry) {
        return undefined;
    }

    const { exp } = decodeJwtPayload(entry.token);

    return exp !== undefined && exp - LAST_KNOWN_TOKEN_MARGIN_SECONDS > nowSeconds() ? entry.token : undefined;
};

/**
 * `authenticated`: a token. `unauthenticated`: the backend ANSWERED that there
 * is no session (or the request carried no session cookie at all). `unknown`:
 * the request carried a session cookie but the token fetch failed (429, 5xx,
 * network) — so nobody knows, and nothing may treat it as signed out.
 */
export type SessionTokenStatus = SessionAuthStatus;

export interface SessionTokenResult {
    isFresh: boolean;
    status: SessionTokenStatus;
    token: string | undefined;
}

export const fetchSessionToken = async (siteUrl: string, headers: Headers, options?: GetTokenOptions): Promise<SessionTokenResult> => {
    const tolerance = options?.jwtCache?.expirationToleranceSeconds ?? 60;
    const sessionCookie = getSessionCookie(headers, {
        cookieName: SESSION_COOKIE_NAME,
        cookiePrefix: options?.cookiePrefix,
    });

    /**
     * The fetch FAILED — not "no session". With no session cookie there is no
     * session to lose, so that stays "unauthenticated"; with one, fall back to
     * the last token this process saw for it, else report "unknown".
     *
     * This used to be `token: undefined` like a real "no session", so one 429
     * on `/api/auth/token` (better-auth rate-limits `/api/auth/*` per IP) made
     * the root route answer `isAuthenticated: false` and every guarded route
     * redirect a signed-in user to sign-in.
     */
    const failed = (cacheKey: string | undefined): SessionTokenResult => {
        if (!sessionCookie) {
            return { isFresh: true, status: "unauthenticated", token: undefined };
        }

        const lastKnown = lastKnownToken(cacheKey);

        return lastKnown ? { isFresh: false, status: "authenticated", token: lastKnown } : { isFresh: true, status: "unknown", token: undefined };
    };

    const fetchToken = async (cacheKey?: string): Promise<SessionTokenResult> => {
        // better-auth's jwt plugin mounts this at `/token`. The path carried a
        // backend-specific segment before the migration and got renamed to
        // `/api/auth/lunora/token`, which no endpoint ever served — it 404'd, so
        // the client never received a token, every `_lunora/rpc` call went out
        // unauthenticated and came back `FORBIDDEN_SHARD`, and the chat route
        // guard bounced to the sign-in page.
        const url = new URL("/api/auth/token", siteUrl);

        // A NETWORK failure has to be caught, not just a non-2xx.
        //
        // This runs in the root route's `beforeLoad`. If the backend is
        // unreachable, `fetch` rejects, the rejection escapes `beforeLoad`, and
        // the router fails the root match on the client — so the page SSRs and
        // serves 200, paints, and then never hydrates. No console error, no
        // toast, nothing: forms fall back to native submits and every button is
        // inert. It reads exactly like a frontend bug, and it cost hours to trace
        // back to "the backend was down".
        //
        // A failure is reported as `unknown` (see `failed`), never thrown, and
        // never as "no session": the guarded routes render instead of
        // redirecting, and `AuthRecovery` adopts the token once the backend
        // answers again.
        let response: Response;

        try {
            // Same deadline as the proxy: a hung token fetch would stall every SSR render.
            response = await fetch(url, { headers, signal: AbortSignal.timeout(AUTH_PROXY_TIMEOUT_MS) });
        } catch {
            return failed(cacheKey);
        }

        if (!response.ok) {
            // Nobody reads this body; an unconsumed one is a `wrangler dev` crash trigger (CLAUDE.md).
            await response.body?.cancel().catch(() => undefined);

            // 429 / 5xx: the backend could not answer. 401 and friends: it did — no session.
            return isRetryableStatus(response.status) ? failed(cacheKey) : { isFresh: true, status: "unauthenticated", token: undefined };
        }

        try {
            const data = (await response.json()) as { token?: string };

            if (data.token && cacheKey) {
                rememberToken(cacheKey, data.token, tolerance);
            }

            return data.token ? { isFresh: true, status: "authenticated", token: data.token } : { isFresh: true, status: "unauthenticated", token: undefined };
        } catch {
            // A truncated or non-JSON 2xx body tells us nothing either way.
            return failed(cacheKey);
        }
    };

    if (!options?.jwtCache?.enabled) {
        return await fetchToken();
    }

    // No session cookie, no cache key — and nothing worth caching either, since
    // the token endpoint answers on the strength of that cookie.
    if (!sessionCookie) {
        return await fetchToken();
    }

    if (options.forceRefresh) {
        // The cached token was just REJECTED, so it is no fallback either.
        tokenCache.delete(sessionCookie);

        return await fetchToken(sessionCookie);
    }

    const cached = tokenCache.get(sessionCookie);

    // A lapsed entry is kept, not deleted: it is the last known token `failed` falls back to.
    if (cached && cached.expiresAt > nowSeconds()) {
        return { isFresh: false, status: "authenticated", token: cached.token };
    }

    return await fetchToken(sessionCookie);
};

const setupClient = (options: ClientOptions): LunoraClient => {
    const client = new LunoraClient({ url: options.lunoraUrl });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};

const parseLunoraSiteUrl = (url: string): string => {
    if (!url) {
        throw new Error("VITE_LUNORA_URL is not set. This is automatically set in the Lunora backend, but must be set in the TanStack Start environment.");
    }

    return url;
};

const proxyHandler = async (request: Request, options: { lunoraSiteUrl: string }): Promise<Response> => {
    const requestUrl = new URL(request.url);
    const nextUrl = `${options.lunoraSiteUrl}${requestUrl.pathname}${requestUrl.search}`;
    const headers = new Headers(request.headers);

    headers.set("accept-encoding", "application/json");
    headers.set("host", new URL(options.lunoraSiteUrl).host);

    try {
        return await fetch(nextUrl, {
            body: request.body,
            // @ts-expect-error - duplex is required for streaming request bodies in modern fetch
            duplex: "half",
            headers,
            method: request.method,
            redirect: "manual",
            signal: AbortSignal.timeout(AUTH_PROXY_TIMEOUT_MS),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            return Response.json({ code: "AUTH_UPSTREAM_TIMEOUT", message: "The auth service did not answer in time." }, { status: 504 });
        }

        throw error;
    }
};

const { cache } = React;

const lunoraBetterAuthReactStart = (
    options: Omit<GetTokenOptions, "forceRefresh"> & {
        lunoraSiteUrl: string;
        lunoraUrl: string;
    },
) => {
    const siteUrl = parseLunoraSiteUrl(options.lunoraSiteUrl);

    const cachedGetToken = cache(async (tokenOptions: GetTokenOptions) => {
        const { getRequestHeaders } = await import("@tanstack/react-start/server");
        const headers = getRequestHeaders();
        const mutableHeaders = new Headers(headers);

        mutableHeaders.delete("content-length");
        mutableHeaders.delete("transfer-encoding");

        return fetchSessionToken(siteUrl, mutableHeaders, tokenOptions);
    });

    const callWithToken = async <FunctionType extends "query" | "mutation" | "action", FunctionRef extends FunctionReference<FunctionType>>(
        function_: (token?: string) => Promise<ReturnOf<FunctionRef>>,
    ): Promise<ReturnOf<FunctionRef>> => {
        const token = await cachedGetToken(options);

        try {
            return await function_(token.token);
        } catch (error) {
            // Only a STALE token is worth retrying, and only for an auth error.
            // The `!` was missing here, which inverted it: the one error a
            // refresh can fix was the one error that skipped the refresh.
            if (!options.jwtCache?.enabled || token.isFresh || !options.jwtCache.isAuthError(error)) {
                throw error;
            }

            const newToken = await cachedGetToken({
                ...options,
                forceRefresh: true,
            });

            return await function_(newToken.token);
        }
    };

    return {
        fetchAuthAction: async <Action extends FunctionReference<"action">>(action: Action, ...args: OptionalRestArgs<Action>): Promise<ReturnOf<Action>> =>
            callWithToken((token?: string) => {
                const client = setupClient({ ...options, token });

                return client.action(action, ...args);
            }),
        fetchAuthMutation: async <Mutation extends FunctionReference<"mutation">>(
            mutation: Mutation,
            ...args: OptionalRestArgs<Mutation>
        ): Promise<ReturnOf<Mutation>> =>
            callWithToken((token?: string) => {
                const client = setupClient({ ...options, token });

                return client.mutation(mutation, ...args);
            }),
        fetchAuthQuery: async <Query extends FunctionReference<"query">>(query: Query, ...args: OptionalRestArgs<Query>): Promise<ReturnOf<Query>> =>
            callWithToken((token?: string) => {
                const client = setupClient({ ...options, token });

                return client.query(query, ...args);
            }),
        getToken: async () => {
            const token = await cachedGetToken(options);

            return token.token;
        },
        /** The token AND whether a missing one means "signed out" or "could not tell" — for route guards. */
        getSessionState: async (): Promise<{ status: SessionTokenStatus; token: string | undefined }> => {
            const { status, token } = await cachedGetToken(options);

            return { status, token };
        },
        handler: (request: Request) => proxyHandler(request, options),
    };
};

export default lunoraBetterAuthReactStart;
