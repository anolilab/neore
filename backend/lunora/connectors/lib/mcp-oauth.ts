/**
 * Generic OAuth client for remote MCP servers, per the MCP authorization spec:
 *
 * 1. **Discovery** — Protected Resource Metadata (RFC 9728), found through the
 *    server's `WWW-Authenticate: … resource_metadata="…"` challenge or the
 *    well-known URIs, names the authorization server; its metadata comes from
 *    RFC 8414 / OpenID discovery. A server with no PRM gets the 2025-03-26
 *    fallback: its own origin is the authorization server.
 * 2. **Client** — a pre-registered client (operator env) when the connector
 *    declares one, else Dynamic Client Registration (RFC 7591).
 * 3. **Authorization code + PKCE S256**, with the RFC 8707 `resource` indicator
 *    on both the authorization and the token request.
 *
 * Nothing here is connector-specific except the two token-revocation quirks at
 * the bottom (GitHub and Slack advertise no RFC 7009 endpoint). So any remote
 * MCP server that implements the spec works — the five seeded connectors are
 * just rows pointing at one.
 *
 * Every URL a server hands us (metadata links, endpoints) is attacker-influenced,
 * so each is checked by {@link assertSafeOAuthUrl} before it is fetched or sent
 * to the browser, and fetches never follow redirects.
 *
 * `fetch` is injected so the parsing and the flow can be unit-tested; production
 * callers pass {@link defaultOAuthFetch}.
 */
import { validateDomain } from "../../chat/tools/utilities";
import { FETCH_TIMEOUT_SHORT_MS, fetchWithDeadline } from "../../lib/fetch-timeout";

export type OAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export const defaultOAuthFetch: OAuthFetch = async (url, init) =>
    await fetchWithDeadline(url, { ...init, redirect: "manual", timeoutMs: FETCH_TIMEOUT_SHORT_MS * 2 });

/**
 * An OAuth protocol error (`error` in a token/registration response), or a
 * discovery failure. `message` is always text we wrote; whatever the provider
 * said in `error_description` is kept apart in `providerDescription`, for logs,
 * because it is not ours to show a user.
 */
export class OAuthError extends Error {
    readonly code: string;

    readonly providerDescription?: string;

    constructor(code: string, message: string, providerDescription?: string) {
        super(message);
        this.code = code;
        this.name = "OAuthError";

        if (providerDescription !== undefined) {
            this.providerDescription = providerDescription;
        }
    }
}

/**
 * HTTPS only, and never a private, loopback or metadata address — the same
 * guard (`validateDomain`) the browser and fetch tools use.
 */
export const assertSafeOAuthUrl = (url: string, label: string): string => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        throw new OAuthError("invalid_metadata", `${label} is not a valid URL`);
    }

    if (parsed.protocol !== "https:") {
        throw new OAuthError("invalid_metadata", `${label} must use https`);
    }

    const blocked = validateDomain(parsed.href);

    if (blocked) {
        throw new OAuthError("invalid_metadata", `${label} is not allowed: ${blocked}`);
    }

    return parsed.href;
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
    authorizationServers: string[];
    resource?: string;
    scopesSupported?: string[];
}

export interface AuthorizationServerMetadata {
    authorizationEndpoint: string;
    codeChallengeMethodsSupported?: string[];
    issuer: string;
    registrationEndpoint?: string;
    revocationEndpoint?: string;
    scopesSupported?: string[];
    tokenEndpoint: string;
    tokenEndpointAuthMethodsSupported?: string[];
}

export interface OAuthDiscovery {
    authorizationServer: AuthorizationServerMetadata;
    /** RFC 8707 resource indicator: the canonical MCP server URI. */
    resource: string;
    scopesSupported?: string[];
}

const stringArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;

const optionalString = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Canonical resource URI (MCP spec): lower-case scheme and host, no fragment, no trailing slash on a bare origin. */
const canonicalResourceUri = (url: string): string => {
    const parsed = new URL(url);

    parsed.hash = "";

    return parsed.pathname === "/" && !parsed.search ? parsed.origin : parsed.href;
};

const RESOURCE_METADATA_PARAM = /resource_metadata\s*=\s*(?:"([^"]+)"|([^\s,]+))/iu;
const SCOPE_SEPARATOR = /[\s,]+/u;

/** `pathname` without trailing slashes, by scanning rather than a backtracking regex. */
const trimTrailingSlashes = (pathname: string): string => {
    let end = pathname.length;

    while (end > 0 && pathname[end - 1] === "/") {
        end -= 1;
    }

    return pathname.slice(0, end);
};

/** Pulls `resource_metadata="…"` out of a `WWW-Authenticate: Bearer …` challenge. */
export const parseResourceMetadataHeader = (header: string | null): string | undefined => {
    if (!header) {
        return undefined;
    }

    const match = RESOURCE_METADATA_PARAM.exec(header);

    return match?.[1] ?? match?.[2];
};

/** RFC 9728 §3.1: path-inserted well-known first, then the origin root. */
export const protectedResourceMetadataUrls = (mcpUrl: string): string[] => {
    const { origin, pathname } = new URL(mcpUrl);
    const path = pathname === "/" ? "" : pathname;
    const urls = [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`];

    return [...new Set(urls)];
};

/**
 * RFC 8414 §3.1 path insertion, then OpenID discovery in both of its forms
 * (inserted and appended), which is how Google publishes its metadata.
 */
export const authorizationServerMetadataUrls = (issuer: string): string[] => {
    const { origin, pathname } = new URL(issuer);
    const path = trimTrailingSlashes(pathname);

    // Order is priority; kept out of a Set literal so no sorter reorders it.
    const candidates = [
        `${origin}/.well-known/oauth-authorization-server${path}`,
        `${origin}/.well-known/openid-configuration${path}`,
        `${origin}${path}/.well-known/openid-configuration`,
    ];

    return [...new Set(candidates)];
};

export const parseProtectedResourceMetadata = (json: unknown): ProtectedResourceMetadata => {
    const document = (json ?? {}) as Record<string, unknown>;
    const authorizationServers = stringArray(document["authorization_servers"]) ?? [];

    if (authorizationServers.length === 0) {
        throw new OAuthError("invalid_metadata", "Protected resource metadata names no authorization server");
    }

    const resource = optionalString(document["resource"]);
    const scopesSupported = stringArray(document["scopes_supported"]);

    return { authorizationServers, ...(resource && { resource }), ...(scopesSupported && { scopesSupported }) };
};

/**
 * Issuer identifiers compare as strings (RFC 8414 §3.3), except that a lone
 * trailing slash is ignored: `https://accounts.google.com/` in protected-resource
 * metadata and `https://accounts.google.com` in the issuer's own document name
 * the same server.
 */
const sameIssuer = (actual: string, expected: string): boolean => {
    const normalise = (issuer: string): string => (issuer.endsWith("/") ? issuer.slice(0, -1) : issuer);

    return normalise(actual) === normalise(expected);
};

export const parseAuthorizationServerMetadata = (json: unknown, expectedIssuer: string): AuthorizationServerMetadata => {
    const document = (json ?? {}) as Record<string, unknown>;
    const authorizationEndpoint = optionalString(document["authorization_endpoint"]);
    const tokenEndpoint = optionalString(document["token_endpoint"]);

    if (!authorizationEndpoint || !tokenEndpoint) {
        throw new OAuthError("invalid_metadata", "Authorization server metadata lacks authorization_endpoint or token_endpoint");
    }

    const codeChallengeMethodsSupported = stringArray(document["code_challenge_methods_supported"]);

    // The MCP spec requires S256. A server that lists methods without it would
    // accept our challenge and then fail the exchange, so refuse up front.
    if (codeChallengeMethodsSupported && !codeChallengeMethodsSupported.includes("S256")) {
        throw new OAuthError("invalid_metadata", "Authorization server does not support PKCE S256");
    }

    const registrationEndpoint = optionalString(document["registration_endpoint"]);
    const revocationEndpoint = optionalString(document["revocation_endpoint"]);
    const scopesSupported = stringArray(document["scopes_supported"]);
    const tokenEndpointAuthMethodsSupported = stringArray(document["token_endpoint_auth_methods_supported"]);

    const issuer = optionalString(document["issuer"]);

    // RFC 8414 §3.3: the metadata must name the issuer it was fetched for, or a
    // document at one issuer's well-known URI could speak for another.
    if (issuer !== undefined && !sameIssuer(issuer, expectedIssuer)) {
        throw new OAuthError("invalid_metadata", "Authorization server metadata names a different issuer than the one it was fetched for");
    }

    return {
        authorizationEndpoint: assertSafeOAuthUrl(authorizationEndpoint, "authorization_endpoint"),
        ...(codeChallengeMethodsSupported && { codeChallengeMethodsSupported }),
        issuer: issuer ?? expectedIssuer,
        ...(registrationEndpoint && { registrationEndpoint: assertSafeOAuthUrl(registrationEndpoint, "registration_endpoint") }),
        ...(revocationEndpoint && { revocationEndpoint: assertSafeOAuthUrl(revocationEndpoint, "revocation_endpoint") }),
        ...(scopesSupported && { scopesSupported }),
        tokenEndpoint: assertSafeOAuthUrl(tokenEndpoint, "token_endpoint"),
        ...(tokenEndpointAuthMethodsSupported && { tokenEndpointAuthMethodsSupported }),
    };
};

/** GET a JSON document; `undefined` on any non-2xx (the caller tries the next candidate). */
const fetchJson = async (fetchImpl: OAuthFetch, url: string): Promise<unknown> => {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, method: "GET" });

    if (!response.ok) {
        await response.body?.cancel();

        return undefined;
    }

    try {
        return await response.json();
    } catch {
        return undefined;
    }
};

const firstJson = async (fetchImpl: OAuthFetch, urls: string[]): Promise<unknown> => {
    for (const url of urls) {
        const json = await fetchJson(fetchImpl, url).catch(() => undefined);

        if (json !== undefined) {
            return json;
        }
    }

    return undefined;
};

/** Ask the server itself: an unauthenticated request should answer 401 with the metadata link. */
const probeResourceMetadataUrl = async (fetchImpl: OAuthFetch, mcpUrl: string): Promise<string | undefined> => {
    try {
        const response = await fetchImpl(mcpUrl, { headers: { Accept: "application/json, text/event-stream" }, method: "GET" });
        const header = response.headers.get("www-authenticate");

        await response.body?.cancel();

        return response.status === 401 ? parseResourceMetadataHeader(header) : undefined;
    } catch {
        return undefined;
    }
};

export const discoverOAuth = async (mcpUrl: string, fetchImpl: OAuthFetch = defaultOAuthFetch): Promise<OAuthDiscovery> => {
    const serverUrl = assertSafeOAuthUrl(mcpUrl, "MCP server URL");
    const advertised = await probeResourceMetadataUrl(fetchImpl, serverUrl);
    const candidates = [...(advertised ? [assertSafeOAuthUrl(advertised, "resource_metadata")] : []), ...protectedResourceMetadataUrls(serverUrl)];
    const prmJson = await firstJson(fetchImpl, [...new Set(candidates)]);

    let issuer: string;
    let resource = canonicalResourceUri(serverUrl);
    let scopesSupported: string[] | undefined;

    if (prmJson === undefined) {
        // 2025-03-26 servers: no PRM, the MCP server's origin is the authorization server.
        issuer = new URL(serverUrl).origin;
    } else {
        const prm = parseProtectedResourceMetadata(prmJson);

        if (prm.resource) {
            // A PRM for some other origin would let this server collect tokens meant for it.
            if (new URL(prm.resource).origin !== new URL(serverUrl).origin) {
                throw new OAuthError("invalid_metadata", "Protected resource metadata is for a different origin");
            }

            resource = canonicalResourceUri(prm.resource);
        }

        issuer = assertSafeOAuthUrl(prm.authorizationServers[0] as string, "authorization server");
        scopesSupported = prm.scopesSupported;
    }

    const asJson = await firstJson(fetchImpl, authorizationServerMetadataUrls(issuer));
    const issuerOrigin = new URL(issuer).origin;
    // No metadata: the spec's fallback endpoints, relative to the authorization server's origin.
    const metadata = asJson ?? {
        authorization_endpoint: `${issuerOrigin}/authorize`,
        registration_endpoint: `${issuerOrigin}/register`,
        token_endpoint: `${issuerOrigin}/token`,
    };
    const authorizationServer = parseAuthorizationServerMetadata(metadata, issuer);

    return { authorizationServer, resource, ...(scopesSupported && { scopesSupported }) };
};

/**
 * Whether an MCP server wants OAuth: it answers an unauthenticated request with
 * 401, or publishes protected-resource metadata. For offering "Sign in" on a
 * server the user added; never throws.
 */
export const probeRequiresOAuth = async (mcpUrl: string, fetchImpl: OAuthFetch = defaultOAuthFetch): Promise<boolean> => {
    let serverUrl: string;

    try {
        serverUrl = assertSafeOAuthUrl(mcpUrl, "MCP server URL");
    } catch {
        return false;
    }

    try {
        const response = await fetchImpl(serverUrl, { headers: { Accept: "application/json, text/event-stream" }, method: "GET" });

        await response.body?.cancel();

        if (response.status === 401) {
            return true;
        }
    } catch {
        // Unreachable is not "needs OAuth"; fall through to the metadata check.
    }

    const prm = await firstJson(fetchImpl, protectedResourceMetadataUrls(serverUrl));

    try {
        return prm !== undefined && parseProtectedResourceMetadata(prm).authorizationServers.length > 0;
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------
// Client registration
// ---------------------------------------------------------------------------

export type TokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

export interface OAuthClient {
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}

/** RFC 8414 says an absent list means `client_secret_basic`; prefer `post` when offered (Slack accepts only that). */
export const chooseTokenEndpointAuthMethod = (supported: string[] | undefined, hasSecret: boolean): TokenEndpointAuthMethod => {
    if (!hasSecret) {
        return "none";
    }

    if (supported?.includes("client_secret_post")) {
        return "client_secret_post";
    }

    return "client_secret_basic";
};

const TOKEN_ENDPOINT_AUTH_METHODS: ReadonlySet<string> = new Set(["client_secret_basic", "client_secret_post", "none"]);

const isTokenEndpointAuthMethod = (value: string | undefined): value is TokenEndpointAuthMethod =>
    value !== undefined && TOKEN_ENDPOINT_AUTH_METHODS.has(value);

export const registerClient = async (
    authorizationServer: AuthorizationServerMetadata,
    options: { clientName: string; redirectUri: string; scope?: string },
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): Promise<OAuthClient> => {
    if (!authorizationServer.registrationEndpoint) {
        throw new OAuthError("registration_unsupported", "Authorization server does not support dynamic client registration");
    }

    // A public client: nothing to keep secret, and `none` is what MCP servers expect from DCR.
    const response = await fetchImpl(authorizationServer.registrationEndpoint, {
        body: JSON.stringify({
            client_name: options.clientName,
            grant_types: ["authorization_code", "refresh_token"],
            redirect_uris: [options.redirectUri],
            response_types: ["code"],
            ...(options.scope && { scope: options.scope }),
            token_endpoint_auth_method: "none",
        }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
    });
    const body = (await response.json().catch(() => {
        return {};
    })) as Record<string, unknown>;

    if (!response.ok || typeof body["client_id"] !== "string") {
        throw new OAuthError(
            optionalString(body["error"]) ?? "registration_failed",
            `Client registration failed (${response.status})${response.ok ? ": no client_id returned" : ""}`,
            optionalString(body["error_description"]),
        );
    }

    const clientSecret = optionalString(body["client_secret"]);
    const method = optionalString(body["token_endpoint_auth_method"]);

    return {
        clientId: body["client_id"],
        ...(clientSecret && { clientSecret }),
        tokenEndpointAuthMethod: isTokenEndpointAuthMethod(method) ? method : chooseTokenEndpointAuthMethod(undefined, Boolean(clientSecret)),
    };
};

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

export const buildAuthorizationUrl = (options: {
    authorizationEndpoint: string;
    clientId: string;
    codeChallenge: string;
    extraParams?: { key: string; value: string }[];
    redirectUri: string;
    resource: string;
    scopes: string[];
    state: string;
}): string => {
    const url = new URL(options.authorizationEndpoint);

    // Operator extras first, so they can never override the security parameters.
    const extraParams = options.extraParams ?? [];

    for (const { key, value } of extraParams) {
        url.searchParams.set(key, value);
    }

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", options.clientId);
    url.searchParams.set("redirect_uri", options.redirectUri);
    url.searchParams.set("state", options.state);
    url.searchParams.set("code_challenge", options.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", options.resource);

    if (options.scopes.length > 0) {
        url.searchParams.set("scope", options.scopes.join(" "));
    }

    return url.href;
};

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenSet {
    accessToken: string;
    /** Display name the provider volunteered (Slack team, Notion workspace). */
    accountLabel?: string;
    /** Epoch ms; absent when the token does not expire (GitHub OAuth apps). */
    expiresAt?: number;
    refreshToken?: string;
    /** Granted scopes, when the provider reports them. */
    scopes?: string[];
}

const splitScopes = (scope: unknown): string[] | undefined =>
    typeof scope === "string" && scope.trim() ? scope.split(SCOPE_SEPARATOR).filter(Boolean) : undefined;

/**
 * Parse a token response. JSON normally; form-encoded when a provider ignores
 * `Accept` (GitHub's legacy default). Slack's user-token endpoint answers 200
 * with `ok: false` on failure, and some Slack responses nest the user grant
 * under `authed_user` — both handled here so callers see one shape.
 */
export const parseTokenResponse = (raw: string, contentType: string | null, now: number): TokenSet => {
    let body: Record<string, unknown>;

    if (contentType?.includes("application/x-www-form-urlencoded")) {
        body = Object.fromEntries(new URLSearchParams(raw));
    } else {
        try {
            body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            throw new OAuthError("invalid_response", "Token endpoint returned a non-JSON body");
        }
    }

    const error = optionalString(body["error"]);

    if (error || body["ok"] === false) {
        throw new OAuthError(error ?? "token_error", "Token request failed", optionalString(body["error_description"]));
    }

    const grant = typeof body["access_token"] === "string" ? body : ((body["authed_user"] ?? {}) as Record<string, unknown>);
    const accessToken = optionalString(grant["access_token"]);

    if (!accessToken) {
        throw new OAuthError("invalid_response", "Token response contains no access_token");
    }

    const expiresIn = Number(grant["expires_in"]);
    const refreshToken = optionalString(grant["refresh_token"]);
    const scopes = splitScopes(grant["scope"]);
    const team = body["team"] as { name?: unknown } | undefined;
    const accountLabel = optionalString(body["workspace_name"]) ?? optionalString(team?.name);

    return {
        accessToken,
        ...(accountLabel && { accountLabel }),
        ...(Number.isFinite(expiresIn) && expiresIn > 0 && { expiresAt: now + expiresIn * 1000 }),
        ...(refreshToken && { refreshToken }),
        ...(scopes && { scopes }),
    };
};

const applyClientAuth = (client: OAuthClient, params: URLSearchParams, headers: Record<string, string>): void => {
    if (client.tokenEndpointAuthMethod === "client_secret_basic" && client.clientSecret) {
        headers["Authorization"] = `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`;

        return;
    }

    params.set("client_id", client.clientId);

    if (client.tokenEndpointAuthMethod === "client_secret_post" && client.clientSecret) {
        params.set("client_secret", client.clientSecret);
    }
};

const postTokenRequest = async (tokenEndpoint: string, client: OAuthClient, params: URLSearchParams, fetchImpl: OAuthFetch): Promise<TokenSet> => {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };

    applyClientAuth(client, params, headers);

    const response = await fetchImpl(assertSafeOAuthUrl(tokenEndpoint, "token_endpoint"), { body: params.toString(), headers, method: "POST" });
    const raw = await response.text();

    if (!response.ok) {
        // Surface the OAuth `error` code (e.g. `invalid_grant`) when there is one.
        try {
            parseTokenResponse(raw, response.headers.get("content-type"), Date.now());
        } catch (error) {
            if (error instanceof OAuthError && error.code !== "invalid_response") {
                throw error;
            }
        }

        throw new OAuthError("token_error", `Token endpoint answered ${response.status}`);
    }

    return parseTokenResponse(raw, response.headers.get("content-type"), Date.now());
};

export const exchangeAuthorizationCode = async (
    options: { client: OAuthClient; code: string; codeVerifier: string; redirectUri: string; resource: string; tokenEndpoint: string },
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): Promise<TokenSet> =>
    await postTokenRequest(
        options.tokenEndpoint,
        options.client,
        new URLSearchParams({
            code: options.code,
            code_verifier: options.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: options.redirectUri,
            resource: options.resource,
        }),
        fetchImpl,
    );

/**
 * Refresh an access token. A provider that rotates refresh tokens returns a new
 * one and invalidates the old; one that does not returns none, and the old one
 * stays valid — so the result keeps `refreshToken` in both cases.
 */
export const refreshAccessToken = async (
    options: { client: OAuthClient; refreshToken: string; resource: string; tokenEndpoint: string },
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): Promise<TokenSet & { refreshToken: string }> => {
    const tokens = await postTokenRequest(
        options.tokenEndpoint,
        options.client,
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: options.refreshToken, resource: options.resource }),
        fetchImpl,
    );

    return { ...tokens, refreshToken: tokens.refreshToken ?? options.refreshToken };
};

// ---------------------------------------------------------------------------
// Revocation (best-effort)
// ---------------------------------------------------------------------------

/**
 * Revoke a grant. RFC 7009 where the server advertises it; GitHub and Slack
 * advertise nothing and have their own endpoints. Never throws — disconnect and
 * GDPR deletion must proceed whether or not the provider cooperates. Returns
 * whether a revocation request was accepted.
 */
export const revokeGrant = async (
    options: { accessToken: string; client: OAuthClient; issuer: string; refreshToken?: string; revocationEndpoint?: string },
    fetchImpl: OAuthFetch = defaultOAuthFetch,
): Promise<boolean> => {
    const send = async (url: string, init: RequestInit): Promise<boolean> => {
        try {
            const response = await fetchImpl(url, init);

            await response.body?.cancel();

            return response.ok;
        } catch {
            return false;
        }
    };

    const issuerHost = (() => {
        try {
            return new URL(options.issuer).hostname;
        } catch {
            return "";
        }
    })();

    if (options.revocationEndpoint) {
        const params = new URLSearchParams({
            token: options.refreshToken ?? options.accessToken,
            token_type_hint: options.refreshToken ? "refresh_token" : "access_token",
        });
        const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };

        applyClientAuth(options.client, params, headers);

        return await send(options.revocationEndpoint, { body: params.toString(), headers, method: "POST" });
    }

    if (issuerHost === "github.com" && options.client.clientSecret) {
        // https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization
        // Deletes the whole grant (not just this token), which is what "disconnect" means.
        return await send(`https://api.github.com/applications/${encodeURIComponent(options.client.clientId)}/grant`, {
            body: JSON.stringify({ access_token: options.accessToken }),
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Basic ${btoa(`${options.client.clientId}:${options.client.clientSecret}`)}`,
                "Content-Type": "application/json",
            },
            method: "DELETE",
        });
    }

    if (issuerHost === "mcp.slack.com" || issuerHost === "slack.com") {
        // https://docs.slack.dev/reference/methods/auth.revoke
        return await send("https://slack.com/api/auth.revoke", { headers: { Authorization: `Bearer ${options.accessToken}` }, method: "POST" });
    }

    return false;
};
