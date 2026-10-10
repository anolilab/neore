/**
 * The generic MCP OAuth client: discovery (PRM → authorization server), DCR,
 * the authorization URL, token responses in each provider's shape, refresh with
 * and without rotation, and the SSRF guard on everything a server hands back.
 *
 * The metadata below mirrors what Notion, GitHub and Google actually serve
 * (fetched 2026-09-23), trimmed to the fields the client reads.
 */
import { describe, expect, it } from "vitest";

import type { OAuthFetch } from "./mcp-oauth";
import {
    assertSafeOAuthUrl,
    authorizationServerMetadataUrls,
    buildAuthorizationUrl,
    chooseTokenEndpointAuthMethod,
    discoverOAuth,
    exchangeAuthorizationCode,
    OAuthError,
    parseResourceMetadataHeader,
    parseTokenResponse,
    probeRequiresOAuth,
    protectedResourceMetadataUrls,
    refreshAccessToken,
    registerClient,
    revokeGrant,
} from "./mcp-oauth";

interface Recorded {
    body?: string;
    headers: Record<string, string>;
    method: string;
    url: string;
}

/** A fetch that answers from a table keyed `METHOD url`, 404 otherwise, and records every call. */
const fakeFetch = (routes: Record<string, () => Response>): OAuthFetch & { calls: Recorded[] } => {
    const calls: Recorded[] = [];
    const impl = (async (url: string, init: RequestInit) => {
        const method = init.method ?? "GET";

        calls.push({ ...(typeof init.body === "string" && { body: init.body }), headers: (init.headers ?? {}) as Record<string, string>, method, url });

        return routes[`${method} ${url}`]?.() ?? new Response("not found", { status: 404 });
    }) as OAuthFetch & { calls: Recorded[] };

    impl.calls = calls;

    return impl;
};

const DIFFERENT_ORIGIN = /different origin/u;
const NO_S256 = /S256/u;
const OTHER_ISSUER = /different issuer/u;

const json =
    (body: unknown, status = 200) =>
    () =>
        Response.json(body, { headers: { "content-type": "application/json" }, status });

describe("well-known URL construction", () => {
    it("tries the path-inserted protected-resource URI before the root", () => {
        expect(protectedResourceMetadataUrls("https://drivemcp.googleapis.com/mcp/v1")).toStrictEqual([
            "https://drivemcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1",
            "https://drivemcp.googleapis.com/.well-known/oauth-protected-resource",
        ]);
    });

    it("inserts an issuer's path (RFC 8414) and falls back to OpenID discovery", () => {
        expect(authorizationServerMetadataUrls("https://github.com/login/oauth")).toStrictEqual([
            "https://github.com/.well-known/oauth-authorization-server/login/oauth",
            "https://github.com/.well-known/openid-configuration/login/oauth",
            "https://github.com/login/oauth/.well-known/openid-configuration",
        ]);
        expect(authorizationServerMetadataUrls("https://accounts.google.com/")).toStrictEqual([
            "https://accounts.google.com/.well-known/oauth-authorization-server",
            "https://accounts.google.com/.well-known/openid-configuration",
        ]);
    });

    it("reads resource_metadata out of a WWW-Authenticate challenge", () => {
        expect(parseResourceMetadataHeader('Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"')).toBe(
            "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
        );
        expect(parseResourceMetadataHeader('Bearer error="invalid_token"')).toBeUndefined();
        expect(parseResourceMetadataHeader(null)).toBeUndefined();
    });
});

describe("discoverOAuth", () => {
    it("follows the 401 challenge to PRM, then to the authorization server (Notion: DCR)", async () => {
        const fetch = fakeFetch({
            "GET https://mcp.notion.com/.well-known/oauth-authorization-server": json({
                authorization_endpoint: "https://mcp.notion.com/authorize",
                code_challenge_methods_supported: ["plain", "S256"],
                issuer: "https://mcp.notion.com",
                registration_endpoint: "https://mcp.notion.com/register",
                revocation_endpoint: "https://mcp.notion.com/token",
                token_endpoint: "https://mcp.notion.com/token",
                token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            }),
            "GET https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": json({
                authorization_servers: ["https://mcp.notion.com"],
                resource: "https://mcp.notion.com/mcp",
            }),
            "GET https://mcp.notion.com/mcp": () =>
                new Response("", {
                    headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp"' },
                    status: 401,
                }),
        });

        const discovery = await discoverOAuth("https://mcp.notion.com/mcp", fetch);

        expect(discovery.resource).toBe("https://mcp.notion.com/mcp");
        expect(discovery.authorizationServer).toMatchObject({
            authorizationEndpoint: "https://mcp.notion.com/authorize",
            registrationEndpoint: "https://mcp.notion.com/register",
            revocationEndpoint: "https://mcp.notion.com/token",
            tokenEndpoint: "https://mcp.notion.com/token",
        });
    });

    it("finds PRM at the well-known path when the server does not challenge (Google), and uses OpenID discovery", async () => {
        const fetch = fakeFetch({
            "GET https://accounts.google.com/.well-known/openid-configuration": json({
                authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                code_challenge_methods_supported: ["plain", "S256"],
                issuer: "https://accounts.google.com",
                revocation_endpoint: "https://oauth2.googleapis.com/revoke",
                token_endpoint: "https://oauth2.googleapis.com/token",
            }),
            "GET https://drivemcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1": json({
                authorization_servers: ["https://accounts.google.com/"],
                resource: "https://drivemcp.googleapis.com/mcp/v1",
            }),
            "GET https://drivemcp.googleapis.com/mcp/v1": json({ jsonrpc: "2.0" }),
        });

        const discovery = await discoverOAuth("https://drivemcp.googleapis.com/mcp/v1", fetch);

        expect(discovery.authorizationServer).toMatchObject({
            issuer: "https://accounts.google.com",
            revocationEndpoint: "https://oauth2.googleapis.com/revoke",
            tokenEndpoint: "https://oauth2.googleapis.com/token",
        });
        expect(discovery.authorizationServer.registrationEndpoint).toBeUndefined();
    });

    it("resolves a path-bearing issuer (GitHub) with no registration endpoint", async () => {
        const fetch = fakeFetch({
            "GET https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/": json({
                authorization_servers: ["https://github.com/login/oauth"],
                resource: "https://api.githubcopilot.com/mcp/",
                scopes_supported: ["repo", "read:org"],
            }),
            "GET https://github.com/.well-known/oauth-authorization-server/login/oauth": json({
                authorization_endpoint: "https://github.com/login/oauth/authorize",
                code_challenge_methods_supported: ["S256"],
                issuer: "https://github.com/login/oauth",
                token_endpoint: "https://github.com/login/oauth/access_token",
            }),
        });

        const discovery = await discoverOAuth("https://api.githubcopilot.com/mcp/", fetch);

        expect(discovery.resource).toBe("https://api.githubcopilot.com/mcp/");
        expect(discovery.scopesSupported).toStrictEqual(["repo", "read:org"]);
        expect(discovery.authorizationServer.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
    });

    it("falls back to the server's own origin and the spec's default endpoints when nothing is published", async () => {
        const discovery = await discoverOAuth("https://legacy-mcp.example.com/mcp", fakeFetch({}));

        expect(discovery.authorizationServer).toMatchObject({
            authorizationEndpoint: "https://legacy-mcp.example.com/authorize",
            registrationEndpoint: "https://legacy-mcp.example.com/register",
            tokenEndpoint: "https://legacy-mcp.example.com/token",
        });
    });

    it("refuses PRM that claims a different origin's resource", async () => {
        const fetch = fakeFetch({
            "GET https://evil-mcp.example.com/.well-known/oauth-protected-resource/mcp": json({
                authorization_servers: ["https://auth.example.com"],
                resource: "https://mcp.notion.com/mcp",
            }),
        });

        await expect(discoverOAuth("https://evil-mcp.example.com/mcp", fetch)).rejects.toThrow(DIFFERENT_ORIGIN);
    });

    it("refuses metadata naming another issuer than the one it was fetched for (RFC 8414 §3.3)", async () => {
        const fetch = fakeFetch({
            "GET https://auth.example.com/.well-known/oauth-authorization-server": json({
                authorization_endpoint: "https://auth.example.com/authorize",
                issuer: "https://mcp.notion.com",
                token_endpoint: "https://auth.example.com/token",
            }),
            "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": json({ authorization_servers: ["https://auth.example.com"] }),
        });

        await expect(discoverOAuth("https://mcp.example.com/mcp", fetch)).rejects.toThrow(OTHER_ISSUER);
    });

    it("accepts an issuer that differs only by a trailing slash", async () => {
        const fetch = fakeFetch({
            "GET https://accounts.google.com/.well-known/oauth-authorization-server": json({
                authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                issuer: "https://accounts.google.com",
                token_endpoint: "https://oauth2.googleapis.com/token",
            }),
            "GET https://drivemcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1": json({
                authorization_servers: ["https://accounts.google.com/"],
            }),
        });

        await expect(discoverOAuth("https://drivemcp.googleapis.com/mcp/v1", fetch)).resolves.toMatchObject({
            authorizationServer: { issuer: "https://accounts.google.com" },
        });
    });

    it("refuses an authorization server without S256", async () => {
        const fetch = fakeFetch({
            "GET https://auth.example.com/.well-known/oauth-authorization-server": json({
                authorization_endpoint: "https://auth.example.com/authorize",
                code_challenge_methods_supported: ["plain"],
                token_endpoint: "https://auth.example.com/token",
            }),
            "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": json({ authorization_servers: ["https://auth.example.com"] }),
        });

        await expect(discoverOAuth("https://mcp.example.com/mcp", fetch)).rejects.toThrow(NO_S256);
    });

    // eslint-disable-next-line sonarjs/no-hardcoded-ip -- the cloud metadata address is exactly what must be refused
    const METADATA_ADDRESS = "169.254.169.254";

    it("refuses metadata that points at a private address", async () => {
        const fetch = fakeFetch({
            "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": json({ authorization_servers: [`https://${METADATA_ADDRESS}`] }),
        });

        await expect(discoverOAuth("https://mcp.example.com/mcp", fetch)).rejects.toBeInstanceOf(OAuthError);
        // Nothing was ever fetched from the metadata address.
        expect(fetch.calls.some((call) => call.url.includes(METADATA_ADDRESS))).toBe(false);
    });
});

describe("assertSafeOAuthUrl", () => {
    it("allows public https", () => {
        expect(assertSafeOAuthUrl("https://mcp.notion.com/token", "x")).toBe("https://mcp.notion.com/token");
    });

    it.each([
        // eslint-disable-next-line unicorn/prefer-https -- plain http is the case under test
        "http://mcp.notion.com/token",
        "https://127.0.0.1/token",
        "https://localhost/token",
        "https://[::1]/token",
        // eslint-disable-next-line no-script-url -- the scheme under test
        "javascript:alert(1)",
        "not a url",
    ])("refuses %s", (url) => {
        expect(() => assertSafeOAuthUrl(url, "x")).toThrow(OAuthError);
    });
});

describe("registerClient (DCR)", () => {
    const authorizationServer = {
        authorizationEndpoint: "https://mcp.notion.com/authorize",
        issuer: "https://mcp.notion.com",
        registrationEndpoint: "https://mcp.notion.com/register",
        tokenEndpoint: "https://mcp.notion.com/token",
    };

    it("registers a public client for our redirect URI", async () => {
        const fetch = fakeFetch({ "POST https://mcp.notion.com/register": json({ client_id: "dyn-123", token_endpoint_auth_method: "none" }, 201) });

        await expect(registerClient(authorizationServer, { clientName: "Neore", redirectUri: "https://app.example.com/cb" }, fetch)).resolves.toStrictEqual({
            clientId: "dyn-123",
            tokenEndpointAuthMethod: "none",
        });
        expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toMatchObject({ redirect_uris: ["https://app.example.com/cb"], token_endpoint_auth_method: "none" });
    });

    it("keeps an issued secret and infers how to send it", async () => {
        const fetch = fakeFetch({ "POST https://mcp.notion.com/register": json({ client_id: "dyn", client_secret: "shh" }) });

        await expect(registerClient(authorizationServer, { clientName: "Neore", redirectUri: "https://app.example.com/cb" }, fetch)).resolves.toStrictEqual({
            clientId: "dyn",
            clientSecret: "shh",
            tokenEndpointAuthMethod: "client_secret_basic",
        });
    });

    it("surfaces a registration error, keeping the provider's description out of the message", async () => {
        const fetch = fakeFetch({
            "POST https://mcp.notion.com/register": json({ error: "invalid_redirect_uri", error_description: "visit evil.example to fix" }, 400),
        });
        const failure = (await registerClient(authorizationServer, { clientName: "Neore", redirectUri: "https://app.example.com/cb" }, fetch).catch(
            (error: unknown) => error,
        )) as OAuthError;

        expect(failure).toMatchObject({ code: "invalid_redirect_uri", providerDescription: "visit evil.example to fix" });
        expect(failure.message).not.toContain("evil.example");
    });

    it("refuses when the server offers no registration endpoint", async () => {
        const withoutDcr = {
            authorizationEndpoint: authorizationServer.authorizationEndpoint,
            issuer: authorizationServer.issuer,
            tokenEndpoint: authorizationServer.tokenEndpoint,
        };

        await expect(registerClient(withoutDcr, { clientName: "Neore", redirectUri: "https://app.example.com/cb" }, fakeFetch({}))).rejects.toMatchObject({
            code: "registration_unsupported",
        });
    });
});

describe("chooseTokenEndpointAuthMethod", () => {
    it("sends nothing secret for a public client", () => {
        expect(chooseTokenEndpointAuthMethod(["client_secret_post"], false)).toBe("none");
    });

    it("prefers post when offered (Slack accepts only post)", () => {
        expect(chooseTokenEndpointAuthMethod(["client_secret_post"], true)).toBe("client_secret_post");
    });

    it("defaults to basic when the server lists nothing (RFC 8414)", () => {
        expect(chooseTokenEndpointAuthMethod(undefined, true)).toBe("client_secret_basic");
    });
});

describe("buildAuthorizationUrl", () => {
    it("sends PKCE S256, state and the resource indicator, and extras cannot override them", () => {
        const url = new URL(
            buildAuthorizationUrl({
                authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
                clientId: "cid",
                codeChallenge: "challenge",
                extraParams: [
                    { key: "access_type", value: "offline" },
                    { key: "code_challenge_method", value: "plain" },
                    { key: "state", value: "attacker" },
                ],
                redirectUri: "https://app.example.com/cb",
                resource: "https://drivemcp.googleapis.com/mcp/v1",
                scopes: ["a", "b"],
                state: "s",
            }),
        );

        expect(Object.fromEntries(url.searchParams)).toStrictEqual({
            access_type: "offline",
            client_id: "cid",
            code_challenge: "challenge",
            code_challenge_method: "S256",
            redirect_uri: "https://app.example.com/cb",
            resource: "https://drivemcp.googleapis.com/mcp/v1",
            response_type: "code",
            scope: "a b",
            state: "s",
        });
    });
});

describe("parseTokenResponse", () => {
    const now = 1_000_000;

    it("reads a standard JSON response", () => {
        expect(
            parseTokenResponse(
                JSON.stringify({ access_token: "at", expires_in: 3600, refresh_token: "rt", scope: "a b", workspace_name: "Acme" }),
                "application/json",
                now,
            ),
        ).toStrictEqual({ accessToken: "at", accountLabel: "Acme", expiresAt: now + 3_600_000, refreshToken: "rt", scopes: ["a", "b"] });
    });

    it("reads GitHub's form-encoded default, with comma-separated scopes and no expiry", () => {
        expect(parseTokenResponse("access_token=gho_x&scope=repo%2Cread%3Aorg&token_type=bearer", "application/x-www-form-urlencoded", now)).toStrictEqual({
            accessToken: "gho_x",
            scopes: ["repo", "read:org"],
        });
    });

    it("reads Slack's nested user grant", () => {
        expect(
            parseTokenResponse(
                JSON.stringify({ authed_user: { access_token: "xoxp", scope: "chat:write" }, ok: true, team: { name: "Team" } }),
                "application/json",
                now,
            ),
        ).toStrictEqual({ accessToken: "xoxp", accountLabel: "Team", scopes: ["chat:write"] });
    });

    it("turns Slack's 200 ok:false into an error", () => {
        expect(() => parseTokenResponse(JSON.stringify({ error: "invalid_code", ok: false }), "application/json", now)).toThrow(
            expect.objectContaining({ code: "invalid_code" }),
        );
    });

    it("surfaces invalid_grant", () => {
        expect(() => parseTokenResponse(JSON.stringify({ error: "invalid_grant" }), "application/json", now)).toThrow(
            expect.objectContaining({ code: "invalid_grant" }),
        );
    });

    it("refuses a response with no access token", () => {
        expect(() => parseTokenResponse("{}", "application/json", now)).toThrow(expect.objectContaining({ code: "invalid_response" }));
    });
});

describe("token requests", () => {
    const tokenEndpoint = "https://oauth2.googleapis.com/token";

    it("exchanges the code with the verifier, redirect URI and resource; secret via post", async () => {
        const fetch = fakeFetch({ [`POST ${tokenEndpoint}`]: json({ access_token: "at", expires_in: 60, refresh_token: "rt" }) });

        await exchangeAuthorizationCode(
            {
                client: { clientId: "cid", clientSecret: "sec", tokenEndpointAuthMethod: "client_secret_post" },
                code: "code",
                codeVerifier: "verifier",
                redirectUri: "https://app.example.com/cb",
                resource: "https://drivemcp.googleapis.com/mcp/v1",
                tokenEndpoint,
            },
            fetch,
        );

        expect(Object.fromEntries(new URLSearchParams(fetch.calls[0]?.body))).toStrictEqual({
            client_id: "cid",
            client_secret: "sec",
            code: "code",
            code_verifier: "verifier",
            grant_type: "authorization_code",
            redirect_uri: "https://app.example.com/cb",
            resource: "https://drivemcp.googleapis.com/mcp/v1",
        });
    });

    it("authenticates with HTTP Basic when that is the method, keeping the secret out of the body", async () => {
        const fetch = fakeFetch({ [`POST ${tokenEndpoint}`]: json({ access_token: "at" }) });

        await exchangeAuthorizationCode(
            {
                client: { clientId: "cid", clientSecret: "sec", tokenEndpointAuthMethod: "client_secret_basic" },
                code: "c",
                codeVerifier: "v",
                redirectUri: "https://app.example.com/cb",
                resource: "https://r.example.com",
                tokenEndpoint,
            },
            fetch,
        );

        expect(fetch.calls[0]?.headers["Authorization"]).toBe(`Basic ${btoa("cid:sec")}`);
        expect(fetch.calls[0]?.body).not.toContain("sec");
    });

    it("stores a rotated refresh token", async () => {
        const fetch = fakeFetch({ [`POST ${tokenEndpoint}`]: json({ access_token: "at2", expires_in: 60, refresh_token: "rt2" }) });

        await expect(
            refreshAccessToken(
                { client: { clientId: "cid", tokenEndpointAuthMethod: "none" }, refreshToken: "rt1", resource: "https://r.example.com", tokenEndpoint },
                fetch,
            ),
        ).resolves.toMatchObject({ accessToken: "at2", refreshToken: "rt2" });
    });

    it("keeps the old refresh token when the provider does not rotate", async () => {
        const fetch = fakeFetch({ [`POST ${tokenEndpoint}`]: json({ access_token: "at2", expires_in: 60 }) });

        await expect(
            refreshAccessToken(
                { client: { clientId: "cid", tokenEndpointAuthMethod: "none" }, refreshToken: "rt1", resource: "https://r.example.com", tokenEndpoint },
                fetch,
            ),
        ).resolves.toMatchObject({ accessToken: "at2", refreshToken: "rt1" });
    });

    it("reports invalid_grant from an error status", async () => {
        const fetch = fakeFetch({ [`POST ${tokenEndpoint}`]: json({ error: "invalid_grant" }, 400) });

        await expect(
            refreshAccessToken(
                { client: { clientId: "cid", tokenEndpointAuthMethod: "none" }, refreshToken: "rt1", resource: "https://r.example.com", tokenEndpoint },
                fetch,
            ),
        ).rejects.toMatchObject({ code: "invalid_grant" });
    });
});

describe("revokeGrant", () => {
    it("uses RFC 7009 when advertised, revoking the refresh token", async () => {
        const fetch = fakeFetch({ "POST https://oauth2.googleapis.com/revoke": () => new Response(null, { status: 200 }) });

        await expect(
            revokeGrant(
                {
                    accessToken: "at",
                    client: { clientId: "cid", tokenEndpointAuthMethod: "none" },
                    issuer: "https://accounts.google.com",
                    refreshToken: "rt",
                    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
                },
                fetch,
            ),
        ).resolves.toBe(true);
        expect(Object.fromEntries(new URLSearchParams(fetch.calls[0]?.body))).toMatchObject({ token: "rt", token_type_hint: "refresh_token" });
    });

    it("deletes the GitHub app grant", async () => {
        const fetch = fakeFetch({ "DELETE https://api.github.com/applications/cid/grant": () => new Response(null, { status: 204 }) });

        await expect(
            revokeGrant(
                {
                    accessToken: "gho",
                    client: { clientId: "cid", clientSecret: "sec", tokenEndpointAuthMethod: "client_secret_post" },
                    issuer: "https://github.com/login/oauth",
                },
                fetch,
            ),
        ).resolves.toBe(true);
    });

    it("calls Slack's auth.revoke", async () => {
        const fetch = fakeFetch({ "POST https://slack.com/api/auth.revoke": json({ ok: true }) });

        await expect(
            revokeGrant(
                { accessToken: "xoxp", client: { clientId: "cid", tokenEndpointAuthMethod: "client_secret_post" }, issuer: "https://mcp.slack.com" },
                fetch,
            ),
        ).resolves.toBe(true);
        expect(fetch.calls[0]?.headers["Authorization"]).toBe("Bearer xoxp");
    });

    it("never throws, and reports false when nothing can revoke", async () => {
        const failing: OAuthFetch = async () => {
            throw new Error("network down");
        };

        await expect(
            revokeGrant(
                {
                    accessToken: "at",
                    client: { clientId: "cid", tokenEndpointAuthMethod: "none" },
                    issuer: "https://accounts.google.com",
                    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
                },
                failing,
            ),
        ).resolves.toBe(false);
        await expect(
            revokeGrant({ accessToken: "at", client: { clientId: "c", tokenEndpointAuthMethod: "none" }, issuer: "https://other.example.com" }, fakeFetch({})),
        ).resolves.toBe(false);
    });
});

describe("probeRequiresOAuth", () => {
    it("is true for a server that answers 401", async () => {
        await expect(
            probeRequiresOAuth("https://mcp.linear.app/mcp", fakeFetch({ "GET https://mcp.linear.app/mcp": () => new Response("", { status: 401 }) })),
        ).resolves.toBe(true);
    });

    it("is true for a server that publishes protected-resource metadata", async () => {
        const fetch = fakeFetch({
            "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp": json({ authorization_servers: ["https://auth.example.com"] }),
            "GET https://mcp.example.com/mcp": () => new Response("", { status: 405 }),
        });

        await expect(probeRequiresOAuth("https://mcp.example.com/mcp", fetch)).resolves.toBe(true);
    });

    it("is false for an open server, an unreachable one, and an unsafe URL", async () => {
        await expect(probeRequiresOAuth("https://open.example.com/mcp", fakeFetch({ "GET https://open.example.com/mcp": json({}) }))).resolves.toBe(false);
        await expect(
            probeRequiresOAuth("https://down.example.com/mcp", async () => {
                throw new Error("ECONNREFUSED");
            }),
        ).resolves.toBe(false);
        await expect(probeRequiresOAuth("https://127.0.0.1/mcp", fakeFetch({}))).resolves.toBe(false);
    });
});
