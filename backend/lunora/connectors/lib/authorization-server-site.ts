/**
 * Whether a user-added MCP server's authorization server is on the server's own
 * site.
 *
 * Protected-resource metadata is the MCP server's own word, so a server the user
 * typed in can name ANY authorization server — Notion's, say. With dynamic
 * registration the user then approves on Notion's real consent screen, and the
 * Notion token is sent as a bearer to the attacker's MCP URL. Every endpoint the
 * browser or our token request reaches must therefore sit on the same
 * registrable domain (eTLD+1) as the MCP server, unless the user explicitly
 * trusted those hosts. Catalogue connectors are exempt: their pairing (GitHub's
 * MCP server on githubcopilot.com, its authorization server on github.com) is
 * the operator's, not the server's, claim.
 *
 * The registrable domain comes from the Public Suffix List (`tldts`), INCLUDING
 * its private section: under shared-hosting suffixes (`workers.dev`,
 * `github.io`, …) anyone can get a subdomain, so each one is its own site. A
 * hand-kept suffix list was used first; it could only err unsafely (grouping two
 * registrants under a suffix it did not know), which is not an error a security
 * boundary should be allowed to make.
 */
import { getDomain } from "tldts";

import type { AuthorizationServerMetadata } from "./mcp-oauth";

const TRAILING_DOT = /\.$/u;

/**
 * The registrable domain (eTLD+1) of `hostname`. An IP literal, or a host the
 * list cannot place (e.g. a bare public suffix), is its own site — the strict
 * answer, so an unplaceable host never matches anything but itself.
 */
export const registrableDomain = (hostname: string): string => {
    const host = hostname.toLowerCase().replace(TRAILING_DOT, "");

    return getDomain(host, { allowPrivateDomains: true }) ?? host;
};

/**
 * The hosts among the authorization server's issuer and endpoints that are NOT
 * on the MCP server's registrable domain, sorted and de-duplicated. Empty means
 * same-site. The authorization endpoint is where the user consents, the token
 * and registration endpoints are where we send the code and register a client,
 * and the issuer is what the metadata claims to be — all four count.
 */
export const foreignAuthorizationServerHosts = (
    mcpUrl: string,
    authorizationServer: Pick<AuthorizationServerMetadata, "authorizationEndpoint" | "issuer" | "registrationEndpoint" | "tokenEndpoint">,
): string[] => {
    const site = registrableDomain(new URL(mcpUrl).hostname);
    const endpoints = [
        authorizationServer.issuer,
        authorizationServer.authorizationEndpoint,
        authorizationServer.tokenEndpoint,
        ...(authorizationServer.registrationEndpoint ? [authorizationServer.registrationEndpoint] : []),
    ];
    const hosts = endpoints.map((endpoint) => new URL(endpoint).hostname.toLowerCase());

    return [...new Set(hosts.filter((host) => registrableDomain(host) !== site))].toSorted((a, b) => a.localeCompare(b));
};

/** Whether the user's earlier "I trust this server" covers every foreign host now in play. */
export const isTrusted = (foreignHosts: ReadonlyArray<string>, trustedHosts: ReadonlyArray<string> | undefined): boolean =>
    foreignHosts.every((host) => trustedHosts?.includes(host) === true);
