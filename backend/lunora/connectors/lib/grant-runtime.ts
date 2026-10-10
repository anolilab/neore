/**
 * Turning stored connector grants into live MCP server configs.
 *
 * Runs in actions only (it decrypts, and it may call a token endpoint). The
 * agent's tool builder calls {@link getConnectorMcpServers}; each connected
 * connector becomes an `MCPServerConfig` carrying a bearer token and its slug,
 * and from there it takes the ordinary MCP path — descriptors, permission keys
 * (`connector:<slug>:<tool>`), approval — with nothing connector-specific.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import type { MCPServerConfig, MCPServerOAuth } from "../../chat/lib/mcp-tools";
import { toolsLogger } from "../../lib/logger";
import { readEnvOAuthClient } from "./client-config";
import type { OAuthClient, OAuthFetch } from "./mcp-oauth";
import { defaultOAuthFetch, OAuthError, refreshAccessToken, revokeGrant } from "./mcp-oauth";
import type { ConnectorTokens } from "./token-crypto";
import { decryptConnectorSecret, decryptConnectorTokens, encryptConnectorTokens } from "./token-crypto";
import type { GrantRef, StoredOAuthClient } from "./validators";

export type { StoredOAuthClient } from "./validators";

/** Refresh this long before expiry, so a token does not lapse mid-run. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** The client to authenticate a token request with. An env client's secret is read fresh, so rotating it needs no migration. */
export const resolveOAuthClient = async (record: StoredOAuthClient): Promise<OAuthClient> => {
    if (record.clientSource === "env") {
        const env = record.clientEnvPrefix ? readEnvOAuthClient(record.clientEnvPrefix) : null;

        return {
            clientId: record.clientId,
            ...(env?.clientSecret && { clientSecret: env.clientSecret }),
            tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
        };
    }

    const clientSecret = record.encryptedClientSecret ? await decryptConnectorSecret(record.encryptedClientSecret) : undefined;

    return { clientId: record.clientId, ...(clientSecret && { clientSecret }), tokenEndpointAuthMethod: record.tokenEndpointAuthMethod };
};

export const needsRefresh = (tokenExpiresAt: number | undefined, now: number): boolean =>
    tokenExpiresAt !== undefined && tokenExpiresAt - now < REFRESH_SKEW_MS;

/** What refreshing needs: which row (in either grant table) and its token columns. */
export interface GrantRecord {
    encryptedTokens: string;
    oauthClient: StoredOAuthClient;
    ref: GrantRef;
    tokenExpiresAt?: number;
}

export interface ConnectorGrant extends GrantRecord {
    hasRefreshToken: boolean;
    mcpProtocol: "http" | "sse";
    mcpUrl: string;
    name: string;
    slug: string;
}

type RefreshOutcome = { accessToken: string } | { error: string; expired: boolean };

/**
 * A usable access token for `grant`, refreshing it first when it is about to
 * expire. The refreshed pair is written through a compare-and-set, and on
 * `invalid_grant` the row is re-read before the grant is declared expired —
 * with a rotating provider, a concurrent run may have refreshed first and
 * invalidated the refresh token this run held.
 *
 * `force` refreshes whatever the clock says — the server just refused the
 * token — and never falls back to the token it refused.
 */
export const obtainAccessToken = async (
    ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
    grant: GrantRecord,
    fetchImpl: OAuthFetch = defaultOAuthFetch,
    options: { force?: boolean } = {},
): Promise<RefreshOutcome> => {
    const force = options.force === true;
    let tokens: ConnectorTokens;

    try {
        tokens = await decryptConnectorTokens(grant.encryptedTokens);
    } catch {
        return { error: "Stored credentials could not be decrypted; reconnect this connector", expired: true };
    }

    const now = Date.now();

    if (!force && !needsRefresh(grant.tokenExpiresAt, now)) {
        return { accessToken: tokens.accessToken };
    }

    if (!tokens.refreshToken) {
        return force || (grant.tokenExpiresAt !== undefined && grant.tokenExpiresAt <= now)
            ? { error: "Access expired; reconnect this connector", expired: true }
            : { accessToken: tokens.accessToken };
    }

    try {
        const refreshed = await refreshAccessToken(
            {
                client: await resolveOAuthClient(grant.oauthClient),
                refreshToken: tokens.refreshToken,
                resource: grant.oauthClient.resource,
                tokenEndpoint: grant.oauthClient.tokenEndpoint,
            },
            fetchImpl,
        );
        const encryptedTokens = await encryptConnectorTokens({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken });
        const result = await ctx.runMutation(internal.connectors.store.storeRefreshedTokens, {
            encryptedTokens,
            expectedEncryptedTokens: grant.encryptedTokens,
            grant: grant.ref,
            hasRefreshToken: true,
            ...(refreshed.expiresAt !== undefined && { tokenExpiresAt: refreshed.expiresAt }),
        });

        if (result.applied || !result.current) {
            return { accessToken: refreshed.accessToken };
        }

        // Someone else refreshed first; theirs is the pair the provider now honours.
        const winner = await decryptConnectorTokens(result.current);

        return { accessToken: winner.accessToken };
    } catch (error) {
        if (error instanceof OAuthError && error.code === "invalid_grant") {
            const current = await ctx.runQuery(internal.connectors.store.getCurrentEncryptedTokens, { grant: grant.ref });

            if (current && current !== grant.encryptedTokens) {
                const rotated = await decryptConnectorTokens(current);

                return { accessToken: rotated.accessToken };
            }

            return { error: "The provider revoked this connection; reconnect it", expired: true };
        }

        const message = error instanceof Error ? error.message : String(error);

        // Transient: keep the grant, and use the old token while it still lives.
        return !force && grant.tokenExpiresAt !== undefined && grant.tokenExpiresAt > now
            ? { accessToken: tokens.accessToken }
            : { error: message, expired: false };
    }
};

const markGrant = async (ctx: Pick<ActionCtx, "runMutation">, grant: GrantRef, outcome: { error: string; expired: boolean }): Promise<void> => {
    await ctx.runMutation(internal.connectors.store.markConnectorStatus, {
        grant,
        lastError: outcome.error,
        status: outcome.expired ? "expired" : "error",
    });
};

/**
 * The 401 hooks `getMCPTools` uses (`MCPServerConfig.oauth`): a FORCED refresh
 * from the row's current ciphertext, and the way to declare the grant dead.
 */
export const oauthHooksFor = (
    ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
    grant: GrantRecord,
    reconnectHint: string,
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): MCPServerOAuth => {
    const markExpired = async (): Promise<void> => {
        await markGrant(ctx, grant.ref, { error: reconnectHint, expired: true });
    };

    return {
        markExpired,
        reconnectHint,
        refresh: async () => {
            const current = await ctx.runQuery(internal.connectors.store.getCurrentEncryptedTokens, { grant: grant.ref });

            if (!current) {
                return null;
            }

            const outcome = await obtainAccessToken(ctx, { ...grant, encryptedTokens: current }, fetchImpl, { force: true });

            if ("error" in outcome) {
                await markGrant(ctx, grant.ref, outcome.expired ? { error: reconnectHint, expired: true } : outcome);

                return null;
            }

            return outcome.accessToken;
        },
    };
};

/** MCP server configs for every usable connector the user has connected, in slug order. */
export const getConnectorMcpServers = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, userId: string): Promise<MCPServerConfig[]> => {
    const grants = (await ctx.runQuery(internal.connectors.store.listConnectorGrants, { userId })) as ConnectorGrant[];

    const servers = await Promise.all(
        grants.map(async (grant): Promise<MCPServerConfig | null> => {
            const outcome = await obtainAccessToken(ctx, grant);

            if ("error" in outcome) {
                toolsLogger.warn(`[connectors] "${grant.slug}" unavailable: ${outcome.error}`);

                await markGrant(ctx, grant.ref, outcome);

                return null;
            }

            return {
                connectorSlug: grant.slug,
                enabled: true,
                headers: [{ key: "Authorization", value: `Bearer ${outcome.accessToken}` }],
                name: grant.name,
                oauth: oauthHooksFor(ctx, grant, `Reconnect ${grant.name} in Settings → Connectors`),
                protocol: grant.mcpProtocol,
                url: grant.mcpUrl,
            };
        }),
    );

    return servers.filter((server) => server !== null);
};

/** Best-effort revocation of a stored grant. Never throws. */
export const revokeStoredGrant = async (
    encryptedTokens: string,
    oauthClient: StoredOAuthClient,
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): Promise<boolean> => {
    try {
        const tokens = await decryptConnectorTokens(encryptedTokens);

        return await revokeGrant(
            {
                accessToken: tokens.accessToken,
                client: await resolveOAuthClient(oauthClient),
                issuer: oauthClient.issuer,
                ...(tokens.refreshToken && { refreshToken: tokens.refreshToken }),
                ...(oauthClient.revocationEndpoint && { revocationEndpoint: oauthClient.revocationEndpoint }),
            },
            fetchImpl,
        );
    } catch {
        return false;
    }
};

interface McpServerGrant {
    encryptedTokens: string;
    grantId: Id<"mcpServerGrants">;
    oauthClient: StoredOAuthClient;
    serverName: string;
    serverUrl: string;
    status: "connected" | "disconnected" | "error" | "expired";
    tokenExpiresAt?: number;
}

/**
 * The user's own MCP servers, with a bearer token attached to each they signed
 * in to. A grant is used only for the server of the same name AND url — edit
 * the URL and the old grant is never sent to the new host.
 *
 * With `pruneOrphans` — pass it ONLY with the user's complete server list — a
 * grant whose server is gone (removed, or its URL changed) is revoked and
 * deleted, so removing a server in settings ends the third-party access too.
 */
export const withMcpServerGrants = async (
    ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
    userId: string,
    servers: MCPServerConfig[],
    options: { fetchImpl?: OAuthFetch; pruneOrphans?: boolean } = {},
): Promise<MCPServerConfig[]> => {
    const fetchImpl = options.fetchImpl ?? defaultOAuthFetch;
    const grants = (await ctx.runQuery(internal.connectors.store.listMcpServerGrants, { userId })) as McpServerGrant[];

    if (grants.length === 0) {
        return servers;
    }

    const byName = new Map(grants.map((grant) => [grant.serverName, grant]));
    const orphans = options.pruneOrphans
        ? grants.filter((grant) => servers.every((server) => !(server.name === grant.serverName && server.url === grant.serverUrl)))
        : [];

    await Promise.all(
        orphans.map(async (grant) => {
            const removed = await ctx.runMutation(internal.connectors.store.deleteMcpServerGrant, { serverName: grant.serverName, userId });

            if (removed) {
                await revokeStoredGrant(removed.encryptedTokens, removed.oauthClient, fetchImpl);
            }
        }),
    );

    return await Promise.all(
        servers.map(async (server) => {
            const grant = byName.get(server.name);

            if (!grant || grant.serverUrl !== server.url || grant.status === "disconnected") {
                return server;
            }

            const record: GrantRecord = {
                encryptedTokens: grant.encryptedTokens,
                oauthClient: grant.oauthClient,
                ref: { id: grant.grantId, table: "mcpServerGrants" },
                ...(grant.tokenExpiresAt !== undefined && { tokenExpiresAt: grant.tokenExpiresAt }),
            };
            const reconnectHint = `Sign in to ${server.name} again in Settings → MCP Servers`;
            const outcome = await obtainAccessToken(ctx, record, fetchImpl);

            if ("error" in outcome) {
                await markGrant(ctx, record.ref, outcome.expired ? { error: reconnectHint, expired: true } : outcome);

                return server;
            }

            return {
                ...server,
                headers: [
                    ...(server.headers ?? []).filter((header) => header.key.toLowerCase() !== "authorization"),
                    { key: "Authorization", value: `Bearer ${outcome.accessToken}` },
                ],
                oauth: oauthHooksFor(ctx, record, reconnectHint, fetchImpl),
            };
        }),
    );
};
