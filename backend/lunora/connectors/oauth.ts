/**
 * Connector OAuth: authorization code + PKCE against the provider's own remote
 * MCP server, with no proxy Worker in between.
 *
 * 1. `startConnectorOAuth` (authenticated action) discovers the server's
 *    authorization server, picks a client (operator env, or dynamic
 *    registration), stores a single-use `state` bound to the caller with the
 *    encrypted PKCE verifier, and returns the authorization URL.
 * 2. The provider redirects the browser to the APP's
 *    `/dashboard/settings/connectors/callback` — not to the backend. That page
 *    is signed in, so completion runs as the same user: a callback URL replayed
 *    into another account's browser fails the `state` ownership check instead of
 *    attaching a stranger's grant to it. (A backend HTTP callback would have no
 *    session to compare against: the browser authenticates to the backend with a
 *    bearer JWT, which a top-level redirect does not carry.)
 * 3. `completeConnectorOAuth` consumes the state, exchanges the code with the
 *    verifier, and stores the tokens encrypted.
 *
 * See `lib/mcp-oauth.ts` for the protocol and `lib/grant-runtime.ts` for refresh.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authAction, rateLimit } from "../lib/crpc";
import { beginOAuthFlow, providerFailure } from "./lib/begin-flow";
import { readEnvOAuthClient } from "./lib/client-config";
import { resolveOAuthClient } from "./lib/grant-runtime";
import { exchangeAuthorizationCode } from "./lib/mcp-oauth";
import { hashOAuthState } from "./lib/pkce";
import { decryptConnectorSecret, encryptConnectorTokens } from "./lib/token-crypto";
import type { StoredOAuthClient } from "./lib/validators";

const vSlug = v.string().check((value) => value.length > 0 && value.length <= 64, { message: "Invalid connector" });

export const startConnectorOAuth = authAction
    .use(rateLimit("connectors/oauth"))
    .input({ connectorSlug: vSlug })
    .output(v.object({ url: v.string() }))
    .action(async ({ args: { connectorSlug }, ctx }) => {
        const definition = await ctx.runQuery(internal.connectors.store.getDefinitionForOAuth, { slug: connectorSlug });

        if (!definition || definition.status === "deprecated") {
            throw new LunoraError("NOT_FOUND", `Connector "${connectorSlug}" not found`);
        }

        if (!definition.requiresOAuth) {
            throw new LunoraError("BAD_REQUEST", `Connector "${connectorSlug}" does not use OAuth`);
        }

        const envClient = definition.oauthClientEnvPrefix ? readEnvOAuthClient(definition.oauthClientEnvPrefix) : null;

        if (definition.oauthClientEnvPrefix && !envClient) {
            throw new LunoraError("BAD_REQUEST", `${definition.name} is not configured on this server`);
        }

        const started = await beginOAuthFlow(ctx, {
            authorizeParams: definition.authorizeParams,
            envClient: envClient && definition.oauthClientEnvPrefix ? { ...envClient, prefix: definition.oauthClientEnvPrefix } : null,
            mcpUrl: definition.mcpUrl,
            scopes: definition.scopes,
            target: { kind: "connector", slug: connectorSlug },
        });

        // Only a user's own server is ever asked to confirm its authorization server.
        if (started.kind !== "redirect") {
            throw new LunoraError("INTERNAL", "Unexpected confirmation request for a catalogue connector");
        }

        ctx.log.event("connectors.start_connector_oauth", { connectorSlug, requiresEnvClient: envClient !== null });

        return { url: started.url };
    });

export const completeConnectorOAuth = authAction
    .use(rateLimit("connectors/oauth"))
    .input({
        code: v.string().check((value) => value.length > 0 && value.length <= 4096, { message: "Invalid authorization code" }),
        state: v.string().check((value) => value.length > 0 && value.length <= 256, { message: "Invalid state" }),
    })
    .output(
        v.object({
            accountLabel: v.optional(v.string()),
            /** `mcp` for one of the user's own servers, so the callback page returns to the right settings screen. */
            kind: v.union(v.literal("connector"), v.literal("mcp")),
            name: v.string(),
        }),
    )
    .action(async ({ args: { code, state }, ctx }) => {
        const consumed = await ctx.runMutation(internal.connectors.store.consumeOAuthState, {
            stateHash: await hashOAuthState(state),
            userId: ctx.user.userId,
        });

        if (!consumed.ok) {
            if (consumed.reason === "wrong_user") {
                throw new LunoraError("FORBIDDEN", "This connection was started by a different account");
            }

            throw new LunoraError(
                "BAD_REQUEST",
                consumed.reason === "expired" ? "The connection request expired — please connect again" : "Unknown or already used connection request",
            );
        }

        const { flow, target } = consumed;
        const definition = target.kind === "connector" ? await ctx.runQuery(internal.connectors.store.getDefinitionForOAuth, { slug: target.slug }) : null;

        if (target.kind === "connector" && !definition) {
            throw new LunoraError("NOT_FOUND", `Connector "${target.slug}" not found`);
        }

        const oauthClient: StoredOAuthClient = {
            ...(flow.clientEnvPrefix && { clientEnvPrefix: flow.clientEnvPrefix }),
            clientId: flow.clientId,
            clientSource: flow.clientSource,
            ...(flow.encryptedClientSecret && { encryptedClientSecret: flow.encryptedClientSecret }),
            issuer: flow.issuer,
            resource: flow.resource,
            ...(flow.revocationEndpoint && { revocationEndpoint: flow.revocationEndpoint }),
            tokenEndpoint: flow.tokenEndpoint,
            tokenEndpointAuthMethod: flow.tokenEndpointAuthMethod,
        };

        let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;

        try {
            tokens = await exchangeAuthorizationCode({
                client: await resolveOAuthClient(oauthClient),
                code,
                codeVerifier: await decryptConnectorSecret(flow.encryptedCodeVerifier),
                redirectUri: flow.redirectUri,
                resource: flow.resource,
                tokenEndpoint: flow.tokenEndpoint,
            });
        } catch (error) {
            throw providerFailure("Token exchange", error);
        }

        const accountLabel = tokens.accountLabel?.slice(0, 200);
        const grant = {
            ...(accountLabel && { accountLabel }),
            encryptedTokens: await encryptConnectorTokens({
                accessToken: tokens.accessToken,
                ...(tokens.refreshToken && { refreshToken: tokens.refreshToken }),
            }),
            hasRefreshToken: Boolean(tokens.refreshToken),
            oauthClient,
            scopes: (tokens.scopes ?? flow.scopes).slice(0, 100),
            ...(tokens.expiresAt !== undefined && { tokenExpiresAt: tokens.expiresAt }),
            userId: ctx.user.userId,
        };

        if (target.kind === "mcp") {
            await ctx.runMutation(internal.connectors.store.saveMcpServerGrant, {
                ...grant,
                serverName: target.name,
                serverUrl: target.url,
                ...(target.trustedAuthorizationServerHosts && { trustedAuthorizationServerHosts: target.trustedAuthorizationServerHosts }),
            });

            ctx.log.event("connectors.complete_connector_oauth", { hasRefreshToken: grant.hasRefreshToken, kind: "mcp" });

            return { ...(accountLabel && { accountLabel }), kind: "mcp" as const, name: target.name };
        }

        await ctx.runMutation(internal.connectors.store.saveConnectorGrant, {
            ...grant,
            connectorSlug: target.slug,
            ...(ctx.user.activeOrganization?.id && { organizationId: ctx.user.activeOrganization.id }),
        });

        ctx.log.event("connectors.complete_connector_oauth", { hasRefreshToken: grant.hasRefreshToken, kind: "connector" });

        return { ...(accountLabel && { accountLabel }), kind: "connector" as const, name: definition?.name ?? target.slug };
    });
