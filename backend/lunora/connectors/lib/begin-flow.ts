/**
 * Starting an OAuth flow against a remote MCP server — shared by catalogue
 * connectors (`startConnectorOAuth`) and the user's own servers
 * (`startMcpServerOAuth`). Discovers the authorization server, picks a client
 * (operator env, else dynamic registration), stores the single-use state with
 * the encrypted PKCE verifier, and returns the URL to send the browser to.
 *
 * For a user's own server whose authorization server lives on another site, it
 * stops BEFORE registering a client and asks for confirmation instead
 * (`authorization-server-site.ts`).
 */
import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { ActionCtx } from "../../_generated/server";
import { SITE_URL } from "../../env";
import { connectorRedirectUri } from "./client-config";
import type { EnvOAuthClient } from "./client-config";
import { foreignAuthorizationServerHosts, isTrusted } from "./authorization-server-site";
import type { OAuthClient } from "./mcp-oauth";
import { buildAuthorizationUrl, chooseTokenEndpointAuthMethod, discoverOAuth, OAuthError, registerClient } from "./mcp-oauth";
import { OAUTH_STATE_TTL_MS } from "./oauth-state";
import { codeChallengeS256, generateCodeVerifier, generateOAuthState, hashOAuthState } from "./pkce";
import { encryptConnectorSecret } from "./token-crypto";
import type { OAuthTarget } from "./validators";

/** An OAuth `error` code is a short ASCII token by spec; anything else a provider sends in its place is not shown. */
const OAUTH_ERROR_CODE = /^[\w.-]{1,64}$/u;

/**
 * Provider errors are shown to the user, so they carry only text we wrote and
 * the spec's error code — never the provider's free-form `error_description`.
 */
export const providerFailure = (step: string, error: unknown): LunoraError => {
    if (!(error instanceof OAuthError)) {
        return new LunoraError("BAD_REQUEST", `${step} failed (the provider could not be reached)`);
    }

    const code = OAUTH_ERROR_CODE.test(error.code) ? error.code : "provider_error";

    return new LunoraError("BAD_REQUEST", `${step} failed (${`${code}: ${error.message}`.slice(0, 200)})`);
};

const requireRedirectUri = (): string => {
    if (!SITE_URL) {
        throw new LunoraError("INTERNAL", "SITE_URL is not configured, so connectors cannot receive an OAuth callback");
    }

    return connectorRedirectUri(SITE_URL);
};

export interface BeginOAuthFlowOptions {
    authorizeParams: { key: string; value: string }[];
    /** A pre-registered client, or `null` to register one dynamically. */
    envClient: (EnvOAuthClient & { prefix: string }) | null;
    mcpUrl: string;
    /** Scopes to request; empty means "whatever the server advertises". */
    scopes: string[];
    /** What completion stores the grant against. */
    target: OAuthTarget;
    /**
     * `mcp` targets only: authorization-server hosts on another site that the
     * user trusts — just confirmed, or recorded on their earlier grant.
     */
    trustedAuthorizationServerHosts?: ReadonlyArray<string>;
}

export type BeginOAuthFlowResult = { authorizationServerHosts: string[]; kind: "confirm"; mcpServerHost: string } | { kind: "redirect"; url: string };

export const beginOAuthFlow = async (
    ctx: Pick<ActionCtx, "runMutation"> & { user: { userId: string } },
    options: BeginOAuthFlowOptions,
): Promise<BeginOAuthFlowResult> => {
    const redirectUri = requireRedirectUri();

    let discovery: Awaited<ReturnType<typeof discoverOAuth>>;

    try {
        discovery = await discoverOAuth(options.mcpUrl);
    } catch (error) {
        throw providerFailure("OAuth discovery", error);
    }

    const { authorizationServer } = discovery;
    let { target } = options;

    if (target.kind === "mcp") {
        const foreignHosts = foreignAuthorizationServerHosts(options.mcpUrl, authorizationServer);

        if (!isTrusted(foreignHosts, options.trustedAuthorizationServerHosts)) {
            return { authorizationServerHosts: foreignHosts, kind: "confirm", mcpServerHost: new URL(options.mcpUrl).hostname };
        }

        // Record exactly the hosts in play, so the grant's trust never widens past what the user saw.
        target = { kind: "mcp", name: target.name, url: target.url, ...(foreignHosts.length > 0 && { trustedAuthorizationServerHosts: foreignHosts }) };
    }

    const scopes = options.scopes.length > 0 ? options.scopes : (discovery.scopesSupported ?? []);
    const { envClient } = options;

    let client: OAuthClient;

    if (envClient) {
        client = {
            clientId: envClient.clientId,
            ...(envClient.clientSecret && { clientSecret: envClient.clientSecret }),
            tokenEndpointAuthMethod: chooseTokenEndpointAuthMethod(authorizationServer.tokenEndpointAuthMethodsSupported, Boolean(envClient.clientSecret)),
        };
    } else {
        try {
            client = await registerClient(authorizationServer, {
                clientName: process.env["APP_NAME"]?.trim() || "Neore",
                redirectUri,
                ...(scopes.length > 0 && { scope: scopes.join(" ") }),
            });
        } catch (error) {
            throw providerFailure("Client registration", error);
        }
    }

    const codeVerifier = generateCodeVerifier();
    const state = generateOAuthState();

    await ctx.runMutation(internal.connectors.store.createOAuthState, {
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        flow: {
            ...(envClient && { clientEnvPrefix: envClient.prefix }),
            clientId: client.clientId,
            clientSource: envClient ? "env" : "dcr",
            // An env client's secret stays in env; only a DCR-issued one is stored.
            ...(!envClient && client.clientSecret && { encryptedClientSecret: await encryptConnectorSecret(client.clientSecret) }),
            encryptedCodeVerifier: await encryptConnectorSecret(codeVerifier),
            issuer: authorizationServer.issuer,
            redirectUri,
            resource: discovery.resource,
            ...(authorizationServer.revocationEndpoint && { revocationEndpoint: authorizationServer.revocationEndpoint }),
            scopes,
            tokenEndpoint: authorizationServer.tokenEndpoint,
            tokenEndpointAuthMethod: client.tokenEndpointAuthMethod,
        },
        stateHash: await hashOAuthState(state),
        target,
        userId: ctx.user.userId,
    });

    const url = buildAuthorizationUrl({
        authorizationEndpoint: authorizationServer.authorizationEndpoint,
        clientId: client.clientId,
        codeChallenge: await codeChallengeS256(codeVerifier),
        extraParams: options.authorizeParams,
        redirectUri,
        resource: discovery.resource,
        scopes,
        state,
    });

    return { kind: "redirect", url };
};
