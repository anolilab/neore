/**
 * User Connectors Management
 *
 * The catalogue as the settings page sees it, the caller's own connections, and
 * disconnect. Nothing here returns a token, a client secret or any other
 * ciphertext — reads are projected through {@link toPublicConnector}.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc } from "../_generated/dataModel";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { MAX_CONNECTORS } from "../lib/read-limits";
import { isConnectorConfigured } from "./lib/client-config";
import { revokeStoredGrant } from "./lib/grant-runtime";
import { vConnectorStatus } from "./lib/validators";

/**
 * What the UI may know about a connection. A `connected` row whose token has
 * lapsed (`tokenExpiresAt` past, no `hasRefreshToken`) is expired in fact; the
 * client derives that, because a query must not read the clock.
 */
const vPublicConnector = v.object({
    accountLabel: v.optional(v.string()),
    connectedAt: v.number(),
    connectorDefinitionId: v.string(),
    hasRefreshToken: v.boolean(),
    id: v.string(),
    lastError: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    scopes: v.array(v.string()),
    status: vConnectorStatus,
    tokenExpiresAt: v.optional(v.number()),
});

const toPublicConnector = (connector: Doc<"userConnectors">) => {
    return {
        ...(connector.accountLabel && { accountLabel: connector.accountLabel }),
        connectedAt: connector.connectedAt,
        connectorDefinitionId: connector.connectorDefinitionId as string,
        hasRefreshToken: connector.hasRefreshToken === true,
        id: connector._id as string,
        ...(connector.lastError && { lastError: connector.lastError }),
        ...(connector.lastUsedAt !== undefined && { lastUsedAt: connector.lastUsedAt }),
        scopes: connector.scopes,
        status: connector.status,
        ...(connector.tokenExpiresAt !== undefined && { tokenExpiresAt: connector.tokenExpiresAt }),
    };
};

/**
 * The catalogue for the settings page: every non-deprecated connector, whether
 * this deployment can run its OAuth flow (`configured`), and the caller's
 * connection to it, if any.
 */
export const listConnectorCatalog = authQuery
    .input({})
    .output(
        v.array(
            v.object({
                availabilityNote: v.optional(v.string()),
                category: v.string(),
                configured: v.boolean(),
                connection: v.union(vPublicConnector, v.null()),
                description: v.string(),
                docsUrl: v.optional(v.string()),
                icon: v.optional(v.string()),
                id: v.string(),
                isPremium: v.boolean(),
                name: v.string(),
                requestedScopes: v.array(v.string()),
                requiresOAuth: v.boolean(),
                slug: v.string(),
                status: v.union(v.literal("active"), v.literal("beta"), v.literal("deprecated")),
            }),
        ),
    )
    .query(async ({ ctx }) => {
        const [{ page: definitions }, connections] = await Promise.all([
            ctx.db.connectorDefinitions.findMany({ limit: MAX_CONNECTORS, orderBy: [{ _creationTime: "asc" }] }),
            ctx.db
                .query("userConnectors")
                .withIndex("by_user_and_definition", (q) => q.eq("userId", ctx.user.userId))
                .collect(),
        ]);
        const byDefinition = new Map(connections.map((connection) => [connection.connectorDefinitionId as string, connection]));

        return definitions
            .filter((definition) => definition.status !== "deprecated")
            .map((definition) => {
                const connection = byDefinition.get(definition._id as string);

                return {
                    ...(definition.availabilityNote && { availabilityNote: definition.availabilityNote }),
                    category: definition.category,
                    configured: isConnectorConfigured(definition),
                    connection: connection ? toPublicConnector(connection) : null,
                    description: definition.description,
                    ...(definition.docsUrl && { docsUrl: definition.docsUrl }),
                    ...(definition.icon && { icon: definition.icon }),
                    id: definition._id as string,
                    isPremium: definition.isPremium,
                    name: definition.name,
                    requestedScopes: definition.oauthScopes,
                    requiresOAuth: definition.requiresOAuth,
                    slug: definition.slug,
                    status: definition.status,
                };
            });
    });

/**
 * Disconnect: revoke the grant at the provider (best-effort — a provider that is
 * down or has already revoked it must not keep the user connected here), then
 * drop every stored secret.
 */
export const disconnectConnector = authAction
    .use(rateLimit("connectors/oauth"))
    .input({ connectorId: v.id("userConnectors") })
    .output(v.object({ revoked: v.boolean(), success: v.boolean() }))
    .action(async ({ args: { connectorId }, ctx }) => {
        const grant = await ctx.runQuery(internal.connectors.store.getOwnedConnectorGrant, { connectorId, userId: ctx.user.userId });

        if (!grant) {
            throw new LunoraError("NOT_FOUND", "Connector not found");
        }

        const revoked = grant.encryptedTokens && grant.oauthClient ? await revokeStoredGrant(grant.encryptedTokens, grant.oauthClient) : false;

        await ctx.runMutation(internal.connectors.store.clearConnectorGrant, { connectorId, userId: ctx.user.userId });

        ctx.log.event("connectors.disconnect_connector", { revoked });

        return { revoked, success: true };
    });
