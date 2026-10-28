/**
 * Revoking a key takes effect on its next MCP call, and the snippet the
 * settings page shows is the credential the endpoint reads.
 *
 * Runs better-auth's REAL api-key plugin — with the options `auth.ts` installs —
 * over its in-memory adapter, behind the same per-request identity resolution
 * `server.ts` does for `/api/v1/*`. Nothing here stands in for the key store,
 * so a cache between `verifyApiKey` and the row would show up as a revoked key
 * that still lists threads.
 */
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import type { LunoraHttpEnv } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { API_KEY_OPTIONS } from "../auth";
import type { ApiKeyAuthApi } from "./identity";
import { API_KEY_HEADER, extractApiKey, resolveApiKeyIdentity } from "./identity";
import { buildMcpClientConfig } from "./mcp-client-config";
import { createPublicApiRouter } from "./router";

vi.mock("../chat/http", () => {
    return { runChatStart: vi.fn() };
});

vi.mock("../lib/http-shard", () => {
    return {
        inShard: async (ctx: unknown, _shardKey: string, handler: (ctx: unknown) => Promise<unknown>) => await handler(ctx),
        shardContext: (ctx: unknown) => ctx,
    };
});

const BASE_URL = "http://localhost:3000";

const buildHarness = async () => {
    const auth = betterAuth({
        baseURL: BASE_URL,
        database: memoryAdapter({ account: [], apikey: [], session: [], user: [], verification: [] }),
        emailAndPassword: { enabled: true },
        plugins: [apiKey(API_KEY_OPTIONS)],
        rateLimit: { enabled: false },
        secret: "a-test-secret-that-is-long-enough-for-lunora-auth",
    });
    const api = auth.api as unknown as ApiKeyAuthApi;
    const signUp = await auth.handler(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
            body: JSON.stringify({ email: "owner@example.com", name: "Owner", password: crypto.randomUUID() }),
            headers: { "content-type": "application/json", origin: BASE_URL },
            method: "POST",
        }),
    );
    const cookie = signUp.headers
        .getSetCookie()
        .map((entry) => entry.split(";", 1)[0])
        .join("; ");
    const { user } = (await signUp.json()) as { user: { id: string } };
    const created = await api.createApiKey({ body: { name: "Claude Code", permissions: { threads: ["read"] }, userId: user.id } });

    const app = new Hono<LunoraHttpEnv>();

    app.use("*", async (c, next) => {
        // What `server.ts`'s `resolveIdentity` does for `/api/v1/*`: verify the key on every request.
        const identity = await resolveApiKeyIdentity(c.req.raw, async (key) => await api.verifyApiKey({ body: { key } }));
        const run = async (ref: { __lunoraRef: string }) =>
            ref.__lunoraRef === "lib_rate_limiter_mutations:applyRateLimit" ? { ok: true } : { continueCursor: "", isDone: true, page: [] };

        (c as unknown as { set: (key: string, value: unknown) => void }).set("lunora", {
            auth: { getIdentity: async () => identity, userId: identity?.userId },
            runMutation: run,
            runQuery: run,
        });
        await next();
    });
    app.route("/api/v1", createPublicApiRouter());

    const callMcp = async (headers: Record<string, string>) =>
        await app.request("https://api.example/api/v1/mcp", {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "list_threads" } }),
            headers: { "Content-Type": "application/json", ...headers },
            method: "POST",
        });
    // The settings page's own call: better-auth's client endpoint, signed in as the owner.
    const revoke = async (keyId: string) =>
        await auth.handler(
            new Request(`${BASE_URL}/api/auth/api-key/delete`, {
                body: JSON.stringify({ keyId }),
                headers: { "content-type": "application/json", cookie, origin: BASE_URL },
                method: "POST",
            }),
        );

    const listKeys = async () => {
        const response = await auth.handler(new Request(`${BASE_URL}/api/auth/api-key/list`, { headers: { cookie, origin: BASE_URL } }));

        return ((await response.json()) as { apiKeys: { lastRequest?: string | null }[] }).apiKeys;
    };

    return { callMcp, created, listKeys, revoke };
};

describe("MCP key revocation", () => {
    it("refuses a revoked key on its very next call", async () => {
        const { callMcp, created, revoke } = await buildHarness();
        const { headerValue } = buildMcpClientConfig(BASE_URL, created.key);
        const headers = { [API_KEY_HEADER]: headerValue };

        const before = await callMcp(headers);

        expect(before.status).toBe(200);
        expect(await before.json()).toMatchObject({ result: { isError: false } });

        const revoked = await revoke(created.id);

        expect(revoked.status).toBe(200);

        const after = await callMcp(headers);

        expect(after.status).toBe(401);
        expect(await after.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    });

    it("stamps the key's last-used time on an MCP call, for the key list to show", async () => {
        const { callMcp, created, listKeys } = await buildHarness();

        const [unused] = await listKeys();

        expect(unused?.lastRequest ?? null).toBeNull();

        await callMcp({ [API_KEY_HEADER]: buildMcpClientConfig(BASE_URL, created.key).headerValue });

        const [used] = await listKeys();

        expect(new Date(used?.lastRequest ?? 0).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
});

describe("MCP client config", () => {
    const KEY = "nk_example-key";

    it("sends the key in the header and scheme `extractApiKey` reads", () => {
        const config = buildMcpClientConfig(BASE_URL, KEY);
        const json = JSON.parse(config.json) as { mcpServers: { neore: { headers: Record<string, string>; url: string } } };
        const { headers, url } = json.mcpServers.neore;

        expect(Object.keys(headers)).toEqual([API_KEY_HEADER]);
        expect(extractApiKey(new Headers(headers))).toBe(KEY);
        expect(config.claudeCommand).toContain(`--header "${API_KEY_HEADER}: ${config.headerValue}"`);
        expect(url).toBe(config.url);
    });

    it("points at the MCP endpoint, whatever trailing slash the origin has", () => {
        expect(buildMcpClientConfig(BASE_URL, KEY).url).toBe("http://localhost:3000/api/v1/mcp");
        expect(buildMcpClientConfig(`${BASE_URL}/`, KEY).url).toBe("http://localhost:3000/api/v1/mcp");
    });
});
