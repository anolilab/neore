/**
 * Token refresh for stored connector grants: when it happens, rotation, the
 * compare-and-set against a concurrent refresher, and when a grant is declared
 * expired. Also the encryption round trip the grants rely on.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Id } from "../../_generated/dataModel";
import type { ConnectorGrant } from "./grant-runtime";
import { needsRefresh, oauthHooksFor, obtainAccessToken, REFRESH_SKEW_MS, withMcpServerGrants } from "./grant-runtime";
import type { OAuthFetch } from "./mcp-oauth";
import { decryptConnectorSecret, decryptConnectorTokens, encryptConnectorSecret, encryptConnectorTokens } from "./token-crypto";

beforeAll(() => {
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", btoa("k".repeat(32)));
});

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

const grantFor = async (tokens: { accessToken: string; refreshToken?: string }, tokenExpiresAt?: number): Promise<ConnectorGrant> => {
    return {
        encryptedTokens: await encryptConnectorTokens(tokens),
        hasRefreshToken: Boolean(tokens.refreshToken),
        mcpProtocol: "http",
        mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
        name: "Google Drive",
        oauthClient: {
            clientId: "cid",
            clientSource: "dcr",
            issuer: "https://accounts.google.com",
            resource: "https://drivemcp.googleapis.com/mcp/v1",
            tokenEndpoint: TOKEN_ENDPOINT,
            tokenEndpointAuthMethod: "none",
        },
        ref: { id: "c1" as Id<"userConnectors">, table: "userConnectors" },
        slug: "google-drive",
        ...(tokenExpiresAt !== undefined && { tokenExpiresAt }),
    };
};

/** A ctx whose store answers the compare-and-set and the re-read the way `connectors/store.ts` does. */
const fakeCtx = (stored: { current: string }) => {
    const writes: Record<string, unknown>[] = [];

    return {
        ctx: {
            runMutation: vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
                writes.push(args);

                if (args["expectedEncryptedTokens"] !== stored.current) {
                    return { applied: false, current: stored.current };
                }

                stored.current = args["encryptedTokens"] as string;

                return { applied: true, current: stored.current };
            }),
            runQuery: vi.fn(async () => stored.current),
        },
        writes,
    };
};

const tokenFetch =
    (body: unknown, status = 200): OAuthFetch =>
    async () =>
        Response.json(body, { headers: { "content-type": "application/json" }, status });

const BASE64 = /^[\d+/A-Za-z]+={0,2}$/u;

describe("token-crypto", () => {
    it("round-trips a token pair under the dedicated key", async () => {
        // The plaintexts contain "-", which the standard base64 alphabet of the
        // ciphertext cannot: a match can only be a leak, never chance. (A two-letter
        // token like "rt" appeared in random ciphertext about 1 run in 30.)
        const tokens = { accessToken: "plain-access-token", refreshToken: "plain-refresh-token" };
        const ciphertext = await encryptConnectorTokens(tokens);

        expect(ciphertext.startsWith("c1:")).toBe(true);
        expect(ciphertext.slice(3)).toMatch(BASE64);
        expect(ciphertext).not.toContain(tokens.accessToken);
        expect(ciphertext).not.toContain(tokens.refreshToken);
        await expect(decryptConnectorTokens(ciphertext)).resolves.toStrictEqual(tokens);
    });

    it("uses a fresh IV every time", async () => {
        expect(await encryptConnectorSecret("same")).not.toBe(await encryptConnectorSecret("same"));
        await expect(decryptConnectorSecret(await encryptConnectorSecret("same"))).resolves.toBe("same");
    });
});

describe("needsRefresh", () => {
    it("refreshes inside the skew window, never for a non-expiring token", () => {
        expect(needsRefresh(undefined, 0)).toBe(false);
        expect(needsRefresh(REFRESH_SKEW_MS + 1, 0)).toBe(false);
        expect(needsRefresh(REFRESH_SKEW_MS - 1, 0)).toBe(true);
    });
});

describe("obtainAccessToken", () => {
    it("uses the stored token while it is fresh, without calling the provider", async () => {
        const grant = await grantFor({ accessToken: "at", refreshToken: "rt" }, Date.now() + 60 * 60 * 1000);
        const { ctx } = fakeCtx({ current: grant.encryptedTokens });
        const fetch = vi.fn<OAuthFetch>();

        await expect(obtainAccessToken(ctx, grant, fetch)).resolves.toStrictEqual({ accessToken: "at" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("refreshes a token about to expire and stores the ROTATED pair", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() + 1000);
        const stored = { current: grant.encryptedTokens };
        const { ctx } = fakeCtx(stored);

        await expect(obtainAccessToken(ctx, grant, tokenFetch({ access_token: "new", expires_in: 3600, refresh_token: "rt2" }))).resolves.toStrictEqual({
            accessToken: "new",
        });
        await expect(decryptConnectorTokens(stored.current)).resolves.toStrictEqual({ accessToken: "new", refreshToken: "rt2" });
    });

    it("keeps the refresh token when the provider does not rotate", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() - 1);
        const stored = { current: grant.encryptedTokens };

        await obtainAccessToken(fakeCtx(stored).ctx, grant, tokenFetch({ access_token: "new", expires_in: 3600 }));

        await expect(decryptConnectorTokens(stored.current)).resolves.toStrictEqual({ accessToken: "new", refreshToken: "rt1" });
    });

    it("defers to a concurrent refresher that won the compare-and-set", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() - 1);
        const winner = await encryptConnectorTokens({ accessToken: "winner", refreshToken: "rt-winner" });
        const stored = { current: winner };

        await expect(
            obtainAccessToken(fakeCtx(stored).ctx, grant, tokenFetch({ access_token: "loser", expires_in: 3600, refresh_token: "rt-loser" })),
        ).resolves.toStrictEqual({
            accessToken: "winner",
        });
        expect(stored.current).toBe(winner);
    });

    it("on invalid_grant, uses a pair someone else rotated in rather than declaring the grant dead", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() - 1);
        const rotated = await encryptConnectorTokens({ accessToken: "rotated", refreshToken: "rt2" });

        await expect(obtainAccessToken(fakeCtx({ current: rotated }).ctx, grant, tokenFetch({ error: "invalid_grant" }, 400))).resolves.toStrictEqual({
            accessToken: "rotated",
        });
    });

    it("declares the grant expired on invalid_grant when nothing changed", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() - 1);

        await expect(
            obtainAccessToken(fakeCtx({ current: grant.encryptedTokens }).ctx, grant, tokenFetch({ error: "invalid_grant" }, 400)),
        ).resolves.toMatchObject({
            expired: true,
        });
    });

    it("declares a lapsed token without a refresh token expired", async () => {
        const grant = await grantFor({ accessToken: "old" }, Date.now() - 1);

        await expect(obtainAccessToken(fakeCtx({ current: grant.encryptedTokens }).ctx, grant, vi.fn<OAuthFetch>())).resolves.toMatchObject({ expired: true });
    });

    it("treats a network failure as transient: the still-valid old token is used", async () => {
        const grant = await grantFor({ accessToken: "old", refreshToken: "rt1" }, Date.now() + 1000);
        const failing: OAuthFetch = async () => {
            throw new Error("network down");
        };

        await expect(obtainAccessToken(fakeCtx({ current: grant.encryptedTokens }).ctx, grant, failing)).resolves.toStrictEqual({ accessToken: "old" });
    });

    it("reports undecryptable credentials as expired", async () => {
        const grant = { ...(await grantFor({ accessToken: "x" })), encryptedTokens: "c1:not-base64-ciphertext" };

        await expect(obtainAccessToken(fakeCtx({ current: grant.encryptedTokens }).ctx, grant, vi.fn<OAuthFetch>())).resolves.toMatchObject({ expired: true });
    });
});

describe("forced refresh (the server just answered 401)", () => {
    it("refreshes even though the clock says the token is fresh", async () => {
        const grant = await grantFor({ accessToken: "refused", refreshToken: "rt1" }, Date.now() + 60 * 60 * 1000);
        const stored = { current: grant.encryptedTokens };

        await expect(
            obtainAccessToken(fakeCtx(stored).ctx, grant, tokenFetch({ access_token: "new", expires_in: 3600 }), { force: true }),
        ).resolves.toStrictEqual({
            accessToken: "new",
        });
    });

    it("never falls back to the refused token", async () => {
        const grant = await grantFor({ accessToken: "refused" }, Date.now() + 60 * 60 * 1000);

        await expect(obtainAccessToken(fakeCtx({ current: grant.encryptedTokens }).ctx, grant, vi.fn<OAuthFetch>(), { force: true })).resolves.toMatchObject({
            expired: true,
        });

        const withRefresh = await grantFor({ accessToken: "refused", refreshToken: "rt1" }, Date.now() + 60 * 60 * 1000);
        const failing: OAuthFetch = async () => {
            throw new Error("network down");
        };

        await expect(obtainAccessToken(fakeCtx({ current: withRefresh.encryptedTokens }).ctx, withRefresh, failing, { force: true })).resolves.toMatchObject({
            expired: false,
        });
    });

    it("oauthHooksFor marks the grant expired, with the reconnect hint, when refresh cannot help", async () => {
        const grant = await grantFor({ accessToken: "refused" }, Date.now() + 60 * 60 * 1000);
        const { ctx, writes } = fakeCtx({ current: grant.encryptedTokens });
        const hooks = oauthHooksFor(ctx, grant, "Reconnect Google Drive in Settings → Connectors", vi.fn<OAuthFetch>());

        await expect(hooks.refresh()).resolves.toBeNull();
        expect(writes).toContainEqual({
            grant: { id: "c1", table: "userConnectors" },
            lastError: "Reconnect Google Drive in Settings → Connectors",
            status: "expired",
        });
    });
});

describe("withMcpServerGrants", () => {
    const serverGrant = async (serverName: string, serverUrl: string) => {
        const grant = await grantFor({ accessToken: `token-${serverName}` });

        return {
            encryptedTokens: grant.encryptedTokens,
            grantId: `g-${serverName}`,
            oauthClient: grant.oauthClient,
            scopes: [],
            serverName,
            serverUrl,
            status: "connected",
        };
    };

    const grantsCtx = (grants: unknown[]) => {
        const deleted: string[] = [];

        return {
            ctx: {
                runMutation: vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
                    if ("serverName" in args) {
                        deleted.push(args["serverName"] as string);

                        return null;
                    }

                    return null;
                }),
                runQuery: vi.fn(async () => grants),
            },
            deleted,
        };
    };

    const saved = (name: string, url: string) => {
        return { enabled: true, headers: [{ key: "Authorization", value: "Bearer user-typed" }], name, protocol: "http" as const, url };
    };

    it("attaches the bearer token only to the server with the same name AND url", async () => {
        const { ctx } = grantsCtx([await serverGrant("Linear", "https://mcp.linear.app/mcp")]);
        const [same, moved] = await withMcpServerGrants(ctx, "alice", [saved("Linear", "https://mcp.linear.app/mcp"), saved("Other", "https://x.example.com")]);

        expect(same?.headers).toStrictEqual([{ key: "Authorization", value: "Bearer token-Linear" }]);
        expect(same?.oauth?.reconnectHint).toBe("Sign in to Linear again in Settings → MCP Servers");
        expect(moved?.oauth).toBeUndefined();

        const [repointed] = await withMcpServerGrants(ctx, "alice", [saved("Linear", "https://evil.example.com/mcp")]);

        expect(repointed?.headers).toStrictEqual([{ key: "Authorization", value: "Bearer user-typed" }]);
    });

    it("revokes and deletes orphaned grants only when given the full list", async () => {
        const { ctx, deleted } = grantsCtx([await serverGrant("Removed", "https://gone.example.com/mcp")]);

        await withMcpServerGrants(ctx, "alice", [saved("Linear", "https://mcp.linear.app/mcp")]);
        expect(deleted).toStrictEqual([]);

        await withMcpServerGrants(ctx, "alice", [saved("Linear", "https://mcp.linear.app/mcp")], { fetchImpl: vi.fn<OAuthFetch>(), pruneOrphans: true });
        expect(deleted).toStrictEqual(["Removed"]);
    });
});
