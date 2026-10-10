/**
 * Internal persistence for the connector OAuth flow and stored grants.
 *
 * Everything here is `internal*`: the only callers are the actions in
 * `connectors/oauth.ts` / `connectors/user-connectors.ts`, the agent's tool
 * builder and GDPR deletion — each of which has already established WHO the
 * user is. Secrets arrive and leave encrypted; nothing in this module decrypts.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { patchRow, withoutUndefined } from "../lib/patch";
import { checkOAuthState } from "./lib/oauth-state";
import type { GrantRef, OAuthTarget } from "./lib/validators";
import { vConnectorStatus, vGrantRef, vOAuthClientRecord, vOAuthFlow, vOAuthTarget } from "./lib/validators";

/** Open flows one user may hold at once; starting more evicts the oldest. */
const MAX_OPEN_FLOWS_PER_USER = 10;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export const getDefinitionForOAuth = internalQuery
    .input({ slug: v.string() })
    .output(
        v.union(
            v.object({
                authorizeParams: v.array(v.object({ key: v.string(), value: v.string() })),
                id: v.string(),
                mcpUrl: v.string(),
                name: v.string(),
                oauthClientEnvPrefix: v.optional(v.string()),
                requiresOAuth: v.boolean(),
                scopes: v.array(v.string()),
                status: v.union(v.literal("active"), v.literal("beta"), v.literal("deprecated")),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { slug }, ctx }) => {
        const definition = await ctx.db.connectorDefinitions.findUnique({ where: { slug } });

        if (!definition) {
            return null;
        }

        return {
            authorizeParams: definition.oauthAuthorizeParams ?? [],
            id: definition._id,
            mcpUrl: definition.mcpWorkerUrl,
            name: definition.name,
            ...(definition.oauthClientEnvPrefix && { oauthClientEnvPrefix: definition.oauthClientEnvPrefix }),
            requiresOAuth: definition.requiresOAuth,
            scopes: definition.oauthScopes,
            status: definition.status,
        };
    });

// ---------------------------------------------------------------------------
// Flow state
// ---------------------------------------------------------------------------

export const createOAuthState = internalMutation
    .input({
        expiresAt: v.number(),
        flow: vOAuthFlow,
        stateHash: v.string(),
        target: vOAuthTarget,
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { expiresAt, flow, stateHash, target, userId }, ctx }) => {
        const now = ctx.now;
        const open = await ctx.db
            .query("oauthStates")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect();

        // Expired rows go now; live ones beyond the cap go oldest-first, so a
        // user (or script) hammering "Connect" cannot grow the table unbounded.
        const live = open.filter((row) => row.expiresAt > now).toSorted((a, b) => a.expiresAt - b.expiresAt);
        const evict = [...open.filter((row) => row.expiresAt <= now), ...live.slice(0, Math.max(0, live.length - (MAX_OPEN_FLOWS_PER_USER - 1)))];

        await Promise.all(evict.map((row) => ctx.db.delete(row._id)));
        await ctx.db.insert("oauthStates", { expiresAt, flow, state: stateHash, target, userId });

        return null;
    });

/** A row's target: `target`, else the legacy `connectorSlug` (+ `mcpServer`) encoding of rows written before it. */
const targetOf = (row: Doc<"oauthStates">): OAuthTarget | null => {
    if (row.target) {
        return row.target;
    }

    if (row.mcpServer) {
        return { kind: "mcp", name: row.mcpServer.name, url: row.mcpServer.url };
    }

    return row.connectorSlug ? { kind: "connector", slug: row.connectorSlug } : null;
};

/**
 * Consume a state for `userId`. Single-use: a valid row is deleted before its
 * flow is returned, so a replayed callback finds nothing. A row that belongs to
 * another user is left alone — refusing must not let a stranger burn someone
 * else's in-flight flow.
 */
export const consumeOAuthState = internalMutation
    .input({ stateHash: v.string(), userId: v.string() })
    .output(
        v.union(
            v.object({ flow: vOAuthFlow, ok: v.literal(true), target: vOAuthTarget }),
            v.object({ ok: v.literal(false), reason: v.union(v.literal("expired"), v.literal("not_found"), v.literal("wrong_user")) }),
        ),
    )
    .mutation(async ({ args: { stateHash, userId }, ctx }) => {
        const row = await ctx.db
            .query("oauthStates")
            .withIndex("by_state", (q) => q.eq("state", stateHash))
            .first();
        const check = checkOAuthState(row, userId, ctx.now);

        if (!check.ok) {
            if (check.reason === "expired" && row) {
                await ctx.db.delete(row._id);
            }

            return check;
        }

        const stored = row as NonNullable<typeof row>;

        await ctx.db.delete(stored._id);

        const target = targetOf(stored);

        // A row written before `flow` existed cannot complete — treat it as gone.
        if (!stored.flow || !target) {
            return { ok: false as const, reason: "not_found" as const };
        }

        return { flow: stored.flow, ok: true as const, target };
    });

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const saveConnectorGrant = internalMutation
    .input({
        accountLabel: v.optional(v.string()),
        connectorSlug: v.string(),
        encryptedTokens: v.string(),
        hasRefreshToken: v.boolean(),
        oauthClient: vOAuthClientRecord,
        organizationId: v.optional(v.string()),
        scopes: v.array(v.string()),
        tokenExpiresAt: v.optional(v.number()),
        userId: v.string(),
    })
    .output(v.object({ connectorId: v.id("userConnectors") }))
    .mutation(async ({ args, ctx }) => {
        const definition = await ctx.db.connectorDefinitions.findUnique({ where: { slug: args.connectorSlug } });

        if (!definition) {
            throw new LunoraError("NOT_FOUND", `Connector "${args.connectorSlug}" not found`);
        }

        const grant = {
            accountLabel: args.accountLabel,
            encryptedTokens: args.encryptedTokens,
            hasRefreshToken: args.hasRefreshToken,
            lastError: undefined,
            oauthClient: args.oauthClient,
            scopes: args.scopes,
            status: "connected" as const,
            tokenExpiresAt: args.tokenExpiresAt,
        };

        const existing = await ctx.db
            .query("userConnectors")
            .withIndex("by_user_and_definition", (q) => q.eq("userId", args.userId).eq("connectorDefinitionId", definition._id))
            .first();

        if (existing) {
            await patchRow(ctx.db, existing, { ...grant, connectedAt: ctx.now });

            return { connectorId: existing._id };
        }

        const connectorId = await ctx.db.insert("userConnectors", {
            ...withoutUndefined(grant),
            connectedAt: ctx.now,
            connectorDefinitionId: definition._id,
            ...(args.organizationId && { organizationId: args.organizationId }),
            userId: args.userId,
        });

        return { connectorId };
    });

const vRuntimeConnector = v.object({
    encryptedTokens: v.string(),
    hasRefreshToken: v.boolean(),
    mcpProtocol: v.union(v.literal("sse"), v.literal("http")),
    mcpUrl: v.string(),
    name: v.string(),
    oauthClient: vOAuthClientRecord,
    ref: vGrantRef,
    slug: v.string(),
    status: vConnectorStatus,
    tokenExpiresAt: v.optional(v.number()),
});

/**
 * The user's usable grants, with their MCP endpoints, in slug order (the order
 * decides runtime-name suffixes, so a resumed run must see the same one).
 */
export const listConnectorGrants = internalQuery
    .input({ userId: v.string() })
    .output(v.array(vRuntimeConnector))
    .query(async ({ args: { userId }, ctx }) => {
        const rows = await ctx.db
            .query("userConnectors")
            .withIndex("by_user_and_definition", (q) => q.eq("userId", userId))
            .collect();

        // `error` is transient (a failed refresh call), so it is retried; `expired`
        // only when a refresh token might still revive it.
        const usable = rows.filter(
            (row) =>
                row.encryptedTokens &&
                row.oauthClient &&
                (row.status === "connected" || row.status === "error" || (row.status === "expired" && row.hasRefreshToken)),
        );

        const grants = await Promise.all(
            usable.map(async (row) => {
                const definition = await ctx.db.connectorDefinitions.findFirst({ where: { _id: row.connectorDefinitionId } });

                if (!definition || definition.status === "deprecated") {
                    return null;
                }

                return {
                    encryptedTokens: row.encryptedTokens as string,
                    hasRefreshToken: row.hasRefreshToken === true,
                    mcpProtocol: definition.mcpProtocol,
                    mcpUrl: definition.mcpWorkerUrl,
                    name: definition.name,
                    oauthClient: row.oauthClient as NonNullable<typeof row.oauthClient>,
                    ref: { id: row._id, table: "userConnectors" as const },
                    slug: definition.slug,
                    status: row.status,
                    ...(row.tokenExpiresAt !== undefined && { tokenExpiresAt: row.tokenExpiresAt }),
                };
            }),
        );

        return grants.filter((grant) => grant !== null).toSorted((a, b) => a.slug.localeCompare(b.slug));
    });

/** One grant, only if `userId` owns it. */
export const getOwnedConnectorGrant = internalQuery
    .input({ connectorId: v.id("userConnectors"), userId: v.string() })
    .output(
        v.union(
            v.object({
                encryptedTokens: v.optional(v.string()),
                oauthClient: v.optional(vOAuthClientRecord),
            }),
            v.null(),
        ),
    )
    .query(async ({ args: { connectorId, userId }, ctx }) => {
        const row = await ctx.db.get(connectorId);

        if (!row || row.userId !== userId) {
            return null;
        }

        return { ...(row.encryptedTokens && { encryptedTokens: row.encryptedTokens }), ...(row.oauthClient && { oauthClient: row.oauthClient }) };
    });

/** Every grant a user holds — connectors and their own MCP servers — for GDPR revocation. */
export const listGrantsForRevocation = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.object({ encryptedTokens: v.string(), oauthClient: vOAuthClientRecord })))
    .query(async ({ args: { userId }, ctx }) => {
        const [connectors, servers] = await Promise.all([
            ctx.db
                .query("userConnectors")
                .withIndex("by_user_and_definition", (q) => q.eq("userId", userId))
                .collect(),
            ctx.db
                .query("mcpServerGrants")
                .withIndex("by_user_and_server", (q) => q.eq("userId", userId))
                .collect(),
        ]);

        return [
            ...connectors.flatMap((row) =>
                row.encryptedTokens && row.oauthClient ? [{ encryptedTokens: row.encryptedTokens, oauthClient: row.oauthClient }] : [],
            ),
            ...servers.map((row) => {
                return { encryptedTokens: row.encryptedTokens, oauthClient: row.oauthClient };
            }),
        ];
    });

// ---------------------------------------------------------------------------
// Grants for the user's own MCP servers
// ---------------------------------------------------------------------------

export const saveMcpServerGrant = internalMutation
    .input({
        accountLabel: v.optional(v.string()),
        encryptedTokens: v.string(),
        hasRefreshToken: v.boolean(),
        oauthClient: vOAuthClientRecord,
        scopes: v.array(v.string()),
        serverName: v.string(),
        serverUrl: v.string(),
        tokenExpiresAt: v.optional(v.number()),
        trustedAuthorizationServerHosts: v.optional(v.array(v.string())),
        userId: v.string(),
    })
    .output(v.object({ grantId: v.id("mcpServerGrants") }))
    .mutation(async ({ args, ctx }) => {
        const grant = {
            accountLabel: args.accountLabel,
            connectedAt: ctx.now,
            encryptedTokens: args.encryptedTokens,
            hasRefreshToken: args.hasRefreshToken,
            lastError: undefined,
            oauthClient: args.oauthClient,
            scopes: args.scopes,
            serverUrl: args.serverUrl,
            status: "connected" as const,
            tokenExpiresAt: args.tokenExpiresAt,
            trustedAuthorizationServerHosts: args.trustedAuthorizationServerHosts,
        };
        const existing = await ctx.db
            .query("mcpServerGrants")
            .withIndex("by_user_and_server", (q) => q.eq("userId", args.userId).eq("serverName", args.serverName))
            .first();

        if (existing) {
            await patchRow(ctx.db, existing, grant);

            return { grantId: existing._id };
        }

        const grantId = await ctx.db.insert("mcpServerGrants", {
            ...(args.accountLabel && { accountLabel: args.accountLabel }),
            connectedAt: grant.connectedAt,
            encryptedTokens: args.encryptedTokens,
            hasRefreshToken: args.hasRefreshToken,
            oauthClient: args.oauthClient,
            scopes: args.scopes,
            serverName: args.serverName,
            serverUrl: args.serverUrl,
            status: "connected",
            ...(args.tokenExpiresAt !== undefined && { tokenExpiresAt: args.tokenExpiresAt }),
            ...(args.trustedAuthorizationServerHosts && { trustedAuthorizationServerHosts: args.trustedAuthorizationServerHosts }),
            userId: args.userId,
        });

        return { grantId };
    });

const vMcpServerGrant = v.object({
    accountLabel: v.optional(v.string()),
    encryptedTokens: v.string(),
    grantId: v.id("mcpServerGrants"),
    hasRefreshToken: v.boolean(),
    lastError: v.optional(v.string()),
    oauthClient: vOAuthClientRecord,
    scopes: v.array(v.string()),
    serverName: v.string(),
    serverUrl: v.string(),
    status: vConnectorStatus,
    tokenExpiresAt: v.optional(v.number()),
    trustedAuthorizationServerHosts: v.optional(v.array(v.string())),
});

export const listMcpServerGrants = internalQuery
    .input({ userId: v.string() })
    .output(v.array(vMcpServerGrant))
    .query(async ({ args: { userId }, ctx }) => {
        const rows = await ctx.db
            .query("mcpServerGrants")
            .withIndex("by_user_and_server", (q) => q.eq("userId", userId))
            .collect();

        return rows.map((row) => {
            return {
                ...(row.accountLabel && { accountLabel: row.accountLabel }),
                encryptedTokens: row.encryptedTokens,
                grantId: row._id,
                hasRefreshToken: row.hasRefreshToken,
                ...(row.lastError && { lastError: row.lastError }),
                oauthClient: row.oauthClient,
                scopes: row.scopes,
                serverName: row.serverName,
                serverUrl: row.serverUrl,
                status: row.status,
                ...(row.tokenExpiresAt !== undefined && { tokenExpiresAt: row.tokenExpiresAt }),
                ...(row.trustedAuthorizationServerHosts && { trustedAuthorizationServerHosts: row.trustedAuthorizationServerHosts }),
            };
        });
    });

/** Delete one of `userId`'s MCP server grants by server name; returns what to revoke, or null when there was none. */
export const deleteMcpServerGrant = internalMutation
    .input({ serverName: v.string(), userId: v.string() })
    .output(v.union(v.object({ encryptedTokens: v.string(), oauthClient: vOAuthClientRecord }), v.null()))
    .mutation(async ({ args: { serverName, userId }, ctx }) => {
        const row = await ctx.db
            .query("mcpServerGrants")
            .withIndex("by_user_and_server", (q) => q.eq("userId", userId).eq("serverName", serverName))
            .first();

        if (!row) {
            return null;
        }

        await ctx.db.delete(row._id);

        return { encryptedTokens: row.encryptedTokens, oauthClient: row.oauthClient };
    });

// ---------------------------------------------------------------------------
// Shared by both grant tables, which carry the same token columns. A grant is
// addressed by a {@link GrantRef} naming its table.
// ---------------------------------------------------------------------------

const getGrantRow = async (ctx: Pick<MutationCtx | QueryCtx, "db">, grant: GrantRef): Promise<Doc<"mcpServerGrants"> | Doc<"userConnectors"> | null> =>
    await ctx.db.get(grant.id);

/** The stored ciphertext right now — for a refresher that lost a race to tell "revoked" from "rotated by someone else". */
export const getCurrentEncryptedTokens = internalQuery
    .input({ grant: vGrantRef })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { grant }, ctx }) => {
        const row = await getGrantRow(ctx, grant);

        return row?.encryptedTokens ?? null;
    });

/**
 * Compare-and-set for a refreshed token pair. Two runs refreshing at once with
 * a rotating provider would otherwise race: the loser's write would store a
 * refresh token the winner's exchange already invalidated. When the stored
 * ciphertext is no longer the one the caller refreshed from, nothing is written
 * and the current value is returned for the caller to use instead.
 */
export const storeRefreshedTokens = internalMutation
    .input({
        encryptedTokens: v.string(),
        expectedEncryptedTokens: v.string(),
        grant: vGrantRef,
        hasRefreshToken: v.boolean(),
        tokenExpiresAt: v.optional(v.number()),
    })
    .output(v.object({ applied: v.boolean(), current: v.union(v.string(), v.null()) }))
    .mutation(async ({ args, ctx }) => {
        const row = await getGrantRow(ctx, args.grant);

        if (!row) {
            return { applied: false, current: null };
        }

        if (row.encryptedTokens !== args.expectedEncryptedTokens) {
            return { applied: false, current: row.encryptedTokens ?? null };
        }

        await patchRow(ctx.db, row, {
            encryptedTokens: args.encryptedTokens,
            hasRefreshToken: args.hasRefreshToken,
            lastError: undefined,
            status: "connected",
            tokenExpiresAt: args.tokenExpiresAt,
        });

        return { applied: true, current: args.encryptedTokens };
    });

export const markConnectorStatus = internalMutation
    .input({ grant: vGrantRef, lastError: v.optional(v.string()), status: vConnectorStatus })
    .output(v.null())
    .mutation(async ({ args: { grant, lastError, status }, ctx }) => {
        const row = await getGrantRow(ctx, grant);

        if (row) {
            await patchRow(ctx.db, row, { lastError: lastError?.slice(0, 500), status });
        }

        return null;
    });

/** Disconnect: drop every secret, keep the row (and its stats) as history. */
export const clearConnectorGrant = internalMutation
    .input({ connectorId: v.id("userConnectors"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args: { connectorId, userId }, ctx }) => {
        const row = await ctx.db.get(connectorId);

        if (!row || row.userId !== userId) {
            return false;
        }

        await patchRow(ctx.db, row, {
            encryptedTokens: undefined,
            hasRefreshToken: undefined,
            kvTokenKey: undefined,
            lastError: undefined,
            oauthClient: undefined,
            status: "disconnected",
            tokenExpiresAt: undefined,
        });

        return true;
    });
