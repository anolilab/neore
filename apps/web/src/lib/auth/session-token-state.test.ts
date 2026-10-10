/**
 * The SSR / server-function side: `fetchSessionToken` feeds the root route's
 * `authStatus`, and `requireSession` is what every guarded `beforeLoad` runs.
 * A 429 on `/api/auth/token` used to produce the same `token: undefined` as a
 * real "no session", and the guards redirected a signed-in user to sign-in.
 */
import { isRedirect } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GetTokenOptions } from "./lunora-auth-start";
import { fetchSessionToken } from "./lunora-auth-start";
import { isSignedOut, requireSession } from "./route-guard";

const SITE = "http://localhost:8788";
const OPTIONS: GetTokenOptions = { cookiePrefix: "neore", jwtCache: { enabled: true, isAuthError: () => false } };

const NOW_SECONDS = 1_800_000_000;

const jwt = (exp: number): string => `h.${btoa(JSON.stringify({ exp })).replaceAll("=", "")}.s`;

/** A distinct session per test: the token cache is module-level and keyed by the cookie. */
const withSession = (): Headers => new Headers({ cookie: `neore.session_token=session-${crypto.randomUUID()}` });

const answer = (response: () => Response) => vi.fn(async () => response());

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe(fetchSessionToken, () => {
    it("a token is authenticated", async () => {
        vi.stubGlobal(
            "fetch",
            answer(() => Response.json({ token: jwt(NOW_SECONDS + 900) })),
        );

        await expect(fetchSessionToken(SITE, withSession(), OPTIONS)).resolves.toMatchObject({ status: "authenticated" });
    });

    it("a 429 with a session cookie is UNKNOWN, not signed out", async () => {
        vi.stubGlobal(
            "fetch",
            answer(() => new Response("{}", { headers: { "X-Retry-After": "8" }, status: 429 })),
        );

        await expect(fetchSessionToken(SITE, withSession(), OPTIONS)).resolves.toStrictEqual({ isFresh: true, status: "unknown", token: undefined });
    });

    it("a 5xx or a network failure with a session cookie is unknown too", async () => {
        vi.stubGlobal(
            "fetch",
            answer(() => new Response(null, { status: 503 })),
        );
        await expect(fetchSessionToken(SITE, withSession(), OPTIONS)).resolves.toMatchObject({ status: "unknown" });

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new TypeError("fetch failed");
            }),
        );
        await expect(fetchSessionToken(SITE, withSession(), OPTIONS)).resolves.toMatchObject({ status: "unknown" });
    });

    it("a 401 is an answer: signed out", async () => {
        vi.stubGlobal(
            "fetch",
            answer(() => new Response(null, { status: 401 })),
        );

        await expect(fetchSessionToken(SITE, withSession(), OPTIONS)).resolves.toMatchObject({ status: "unauthenticated", token: undefined });
    });

    it("a failed fetch with NO session cookie is signed out — there is nothing to lose", async () => {
        vi.stubGlobal(
            "fetch",
            answer(() => new Response(null, { status: 429 })),
        );

        await expect(fetchSessionToken(SITE, new Headers(), OPTIONS)).resolves.toMatchObject({ status: "unauthenticated" });
    });

    it("keeps the last known token when a refresh is rate-limited", async () => {
        const headers = withSession();
        const token = jwt(NOW_SECONDS + 900);

        vi.stubGlobal(
            "fetch",
            answer(() => Response.json({ token })),
        );
        await fetchSessionToken(SITE, headers, OPTIONS);

        // Past the 60 s cache slot, so the next call fetches — and is refused.
        vi.setSystemTime((NOW_SECONDS + 120) * 1000);
        vi.stubGlobal(
            "fetch",
            answer(() => new Response(null, { status: 429 })),
        );

        await expect(fetchSessionToken(SITE, headers, OPTIONS)).resolves.toStrictEqual({ isFresh: false, status: "authenticated", token });
    });

    it("does not fall back to a last known token the backend would reject", async () => {
        const headers = withSession();

        vi.stubGlobal(
            "fetch",
            answer(() => Response.json({ token: jwt(NOW_SECONDS + 90) })),
        );
        await fetchSessionToken(SITE, headers, OPTIONS);

        vi.setSystemTime((NOW_SECONDS + 100) * 1000);
        vi.stubGlobal(
            "fetch",
            answer(() => new Response(null, { status: 429 })),
        );

        await expect(fetchSessionToken(SITE, headers, OPTIONS)).resolves.toMatchObject({ status: "unknown", token: undefined });
    });
});

describe(requireSession, () => {
    const redirectOf = (run: () => void): unknown => {
        try {
            run();
        } catch (error) {
            return error;
        }

        return undefined;
    };

    it("redirects to sign-in only when the backend answered 'no session'", () => {
        const thrown = redirectOf(() => requireSession({ authStatus: "unauthenticated", isAuthenticated: false }));

        expect(isRedirect(thrown)).toBe(true);
        expect(isSignedOut({ authStatus: "unauthenticated" })).toBe(true);
    });

    it("never redirects on a failed read (unknown)", () => {
        expect(redirectOf(() => requireSession({ authStatus: "unknown", isAuthenticated: false }))).toBeUndefined();
    });

    it("lets an authenticated visitor through", () => {
        expect(redirectOf(() => requireSession({ authStatus: "authenticated", isAuthenticated: true }))).toBeUndefined();
    });

    it("falls back to isAuthenticated for a context without a status", () => {
        expect(isSignedOut({ isAuthenticated: false })).toBe(true);
        expect(isSignedOut({ isAuthenticated: true })).toBe(false);
    });
});
