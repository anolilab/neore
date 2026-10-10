/**
 * The connector OAuth shapes, declared once: `schema.ts` builds its columns from
 * these, and `connectors/store.ts` validates arguments and results with them.
 * No runtime imports beyond `v`, so the schema can import this module.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

export const vTokenEndpointAuthMethod = v.union(v.literal("client_secret_basic"), v.literal("client_secret_post"), v.literal("none"));

/** How to refresh and revoke a grant: the client it was issued to, and the authorization server's endpoints. */
export const oauthClientRecordFields = {
    clientEnvPrefix: v.optional(v.string()),
    clientId: v.string(),
    clientSource: v.union(v.literal("dcr"), v.literal("env")),
    encryptedClientSecret: v.optional(v.string()),
    issuer: v.string(),
    resource: v.string(),
    revocationEndpoint: v.optional(v.string()),
    tokenEndpoint: v.string(),
    tokenEndpointAuthMethod: vTokenEndpointAuthMethod,
};

// Spread, not `v.object(oauthClientRecordFields)`: codegen resolves an object
// literal but types a bare const argument as `{}`.
export const vOAuthClientRecord = v.object({ ...oauthClientRecordFields });

export type StoredOAuthClient = Infer<typeof vOAuthClientRecord>;

/** An open flow: the client record plus what only the code exchange needs. */
export const vOAuthFlow = v.object({
    ...oauthClientRecordFields,
    encryptedCodeVerifier: v.string(),
    redirectUri: v.string(),
    scopes: v.array(v.string()),
});

export type OAuthFlow = Infer<typeof vOAuthFlow>;

/**
 * What a flow signs in to: a catalogue connector, or one of the user's own MCP
 * servers. For the latter, `trustedAuthorizationServerHosts` records the hosts
 * the user explicitly trusted when the authorization server lives on another
 * site than the MCP server (`lib/authorization-server-site.ts`).
 */
export const vOAuthTarget = v.union(
    v.object({ kind: v.literal("connector"), slug: v.string() }),
    v.object({
        kind: v.literal("mcp"),
        name: v.string(),
        trustedAuthorizationServerHosts: v.optional(v.array(v.string())),
        url: v.string(),
    }),
);

export type OAuthTarget = Infer<typeof vOAuthTarget>;

/** A stored grant, named with its table: connectors and the user's own MCP servers keep grants in two tables with the same token columns. */
export const vGrantRef = v.union(
    v.object({ id: v.id("userConnectors"), table: v.literal("userConnectors") }),
    v.object({ id: v.id("mcpServerGrants"), table: v.literal("mcpServerGrants") }),
);

export type GrantRef = Infer<typeof vGrantRef>;

export const vConnectorStatus = v.union(v.literal("connected"), v.literal("disconnected"), v.literal("expired"), v.literal("error"));
