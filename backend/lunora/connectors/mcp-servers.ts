/**
 * OAuth sign-in for MCP servers the USER added (`aiUserPreferences.mcpServers`).
 *
 * The same flow as catalogue connectors (`lib/begin-flow.ts`, completed by
 * `completeConnectorOAuth` on the app callback route), except the client is
 * always registered dynamically — a server a user typed in has no operator app —
 * and the grant lands in `mcpServerGrants`, keyed by server name AND url.
 * `lib/grant-runtime.ts#withMcpServerGrants` attaches it at run time and revokes
 * a grant whose server was removed or re-pointed.
 *
 * A server whose authorization server lives on another site gets a `confirm`
 * answer instead of a URL (`lib/authorization-server-site.ts`): the settings page
 * shows both hosts and, if the user trusts them, starts again passing them as
 * `trustAuthorizationServerHosts`. That trust is kept on the grant, so signing in
 * again to the same server and hosts does not ask twice.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { beginOAuthFlow } from "./lib/begin-flow";
import { revokeStoredGrant } from "./lib/grant-runtime";

const vServerName = v.string().check((value) => value.length > 0 && value.length <= 200, { message: "Invalid server name" });

const vHosts = v.array(v.string().check((value) => value.length > 0 && value.length <= 253, { message: "Invalid host" })).check((value) => value.length <= 8, {
    message: "Too many hosts",
});

export const startMcpServerOAuth = authAction
    .use(rateLimit("connectors/oauth"))
    .input({
        serverName: vServerName,
        /** The authorization-server hosts the user just confirmed they trust, echoed from a `confirm` answer. */
        trustAuthorizationServerHosts: v.optional(vHosts),
    })
    .output(
        v.union(
            v.object({ kind: v.literal("redirect"), url: v.string() }),
            v.object({ authorizationServerHosts: v.array(v.string()), kind: v.literal("confirm"), mcpServerHost: v.string() }),
        ),
    )
    .action(async ({ args: { serverName, trustAuthorizationServerHosts }, ctx }) => {
        const [servers, grants] = await Promise.all([
            ctx.runQuery(internal.auth.functions.getMCPServersQuery, { userId: ctx.user.userId }),
            ctx.runQuery(internal.connectors.store.listMcpServerGrants, { userId: ctx.user.userId }),
        ]);
        const server = servers.find((candidate) => candidate.name === serverName);

        if (!server) {
            throw new LunoraError("NOT_FOUND", `MCP server "${serverName}" not found — save it first`);
        }

        // Earlier trust counts only for the same server at the same URL.
        const previous = grants.find((grant) => grant.serverName === server.name && grant.serverUrl === server.url);

        const started = await beginOAuthFlow(ctx, {
            authorizeParams: [],
            envClient: null,
            mcpUrl: server.url,
            scopes: [],
            target: { kind: "mcp", name: server.name, url: server.url },
            trustedAuthorizationServerHosts: [...(trustAuthorizationServerHosts ?? []), ...(previous?.trustedAuthorizationServerHosts ?? [])],
        });

        ctx.log.event("connectors.start_mcp_server_oauth", { kind: started.kind });

        return started;
    });

/** Sign out of one server: revoke at its authorization server (best-effort) and forget the grant. */
export const signOutMcpServer = authAction
    .use(rateLimit("connectors/oauth"))
    .input({ serverName: vServerName })
    .output(v.object({ revoked: v.boolean(), signedOut: v.boolean() }))
    .action(async ({ args: { serverName }, ctx }) => {
        const removed = await ctx.runMutation(internal.connectors.store.deleteMcpServerGrant, { serverName, userId: ctx.user.userId });

        if (!removed) {
            return { revoked: false, signedOut: false };
        }

        const revoked = await revokeStoredGrant(removed.encryptedTokens, removed.oauthClient);

        ctx.log.event("connectors.sign_out_mcp_server", { revoked, signedOut: true });

        return { revoked, signedOut: true };
    });

/** Which of the caller's servers they are signed in to. Secret-free. */
export const listMcpServerSignIns = authQuery
    .input({})
    .output(
        v.array(
            v.object({
                accountLabel: v.optional(v.string()),
                hasRefreshToken: v.boolean(),
                lastError: v.optional(v.string()),
                scopes: v.array(v.string()),
                serverName: v.string(),
                serverUrl: v.string(),
                status: v.union(v.literal("connected"), v.literal("disconnected"), v.literal("expired"), v.literal("error")),
                tokenExpiresAt: v.optional(v.number()),
            }),
        ),
    )
    .query(async ({ ctx }) => {
        const rows = await ctx.db
            .query("mcpServerGrants")
            .withIndex("by_user_and_server", (q) => q.eq("userId", ctx.user.userId))
            .collect();

        return rows.map((row) => {
            return {
                ...(row.accountLabel && { accountLabel: row.accountLabel }),
                hasRefreshToken: row.hasRefreshToken,
                ...(row.lastError && { lastError: row.lastError }),
                scopes: row.scopes,
                serverName: row.serverName,
                serverUrl: row.serverUrl,
                status: row.status,
                ...(row.tokenExpiresAt !== undefined && { tokenExpiresAt: row.tokenExpiresAt }),
            };
        });
    });
