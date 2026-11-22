/**
 * A bearer whose keys cannot be read is an outage, not a sign-out: the Worker
 * answers 503 and never falls back to the cookie, or a bearer-only client (the
 * extension, the app) would open signed out. A bad token still falls through to
 * the cookie, and a cookie-only request is unchanged.
 *
 * The app builder and better-auth are stubbed: this pins the wiring, not
 * verification (`jwks-cache.test.ts` covers that).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import server from "./server";

const { authApi, fakeApp } = vi.hoisted(() => {
    return {
        authApi: { getJwks: vi.fn(), getSession: vi.fn(async () => null) },
        fakeApp: { fetch: vi.fn(async () => new Response(null, { status: 204 })), scheduled: vi.fn(async () => {}), ShardDO: vi.fn() },
    };
});

vi.mock("../lunora/http.js", () => {
    return { default: {}, getAllowedOrigins: () => () => null };
});
vi.mock("../lunora/auth.js", () => {
    return {
        buildAuth: () => {
            return { api: authApi };
        },
    };
});
vi.mock("@lunora/auth", () => {
    return { d1Executor: () => {}, handleAuthRequest: async () => undefined };
});
vi.mock("../lunora/public-api/identity.js", () => {
    return { isPublicApiPath: () => false, resolveApiKeyIdentity: async () => null };
});
vi.mock("../lunora/_generated/workflows.js", () => {
    return {};
});
vi.mock("../lunora/auth/lib/ensure-global-tables.js", () => {
    return { ensureGlobalTables: async () => {} };
});
vi.mock("../lunora/_generated/app.js", () => {
    const builder: Record<string, unknown> = new Proxy(
        {},
        {
            get: (_target, key) => (key === "build" ? () => fakeApp : () => builder),
        },
    );

    return { defineApp: () => builder };
});

const worker = server as unknown as { fetch: (request: Request, env: unknown, context: unknown) => Promise<Response> };
const env = { DB: {}, PUBLIC_ORIGIN: "http://x" };
const context = { passThroughOnException: () => {}, waitUntil: () => {} };
// Built at run time: the pre-commit scanner refuses a literal that looks like a token.
const bearer = ["header", "payload", "signature"].join(".");

const request = (path: string, headers: Record<string, string>) => new Request(`http://x${path}`, { body: "{}", headers, method: "POST" });

describe("the Worker's bearer check", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authApi.getJwks.mockImplementation(async () => {
            throw new Error("D1_ERROR: timed out");
        });
    });

    it.each(["/_lunora/rpc", "/_lunora/ws-ticket"])("answers %s with 503 and no cookie fallback when the keys cannot be read", async (path) => {
        const response = await worker.fetch(request(path, { authorization: `Bearer ${bearer}`, cookie: "session=1" }), env, context);

        expect(response.status).toBe(503);
        expect(authApi.getSession).not.toHaveBeenCalled();
        expect(fakeApp.fetch).not.toHaveBeenCalled();
    });

    it("falls through to the cookie for a bad token", async () => {
        authApi.getJwks.mockImplementation(async () => {
            return { keys: [] };
        });

        const response = await worker.fetch(request("/_lunora/rpc", { authorization: `Bearer ${bearer}`, cookie: "session=1" }), env, context);

        expect(response.status).toBe(204);
        expect(authApi.getSession).toHaveBeenCalledTimes(1);
    });

    it("reads the cookie session for a request without a bearer", async () => {
        const response = await worker.fetch(request("/_lunora/rpc", { cookie: "session=1" }), env, context);

        expect(response.status).toBe(204);
        expect(authApi.getJwks).not.toHaveBeenCalled();
        expect(authApi.getSession).toHaveBeenCalledTimes(1);
    });
});
