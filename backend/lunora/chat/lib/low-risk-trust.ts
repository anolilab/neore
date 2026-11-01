/**
 * Which servers the user trusts to have their tools auto-approved by the quick check
 * (`aiUserPreferences.lowRiskTrustedServers`, `low-risk-approval.ts`).
 *
 * A server's tool descriptions and schemas reach the model unfiltered, so a malicious server can steer the model into
 * calling another server's read tool with chat data, and the check only sees the call's key and arguments. Only tools
 * of a server the user marked as trusted are put to the check.
 *
 * An entry names the server's identity, not just its label: an MCP server by name AND url (a server whose url changes
 * loses its trust), a connector by its slug.
 *
 * No imports: the web settings page bundles this file to tell which servers are trusted.
 */
/** The most servers a user can trust. */
export const MAX_TRUSTED_SERVERS = 50;

/** The trust entry for an MCP server. The pair is JSON so no name/url split can read as another server. */
export const mcpTrustId = (name: string, url: string): string => `mcp:${JSON.stringify([name, url])}`;

/** The trust entry for a connector. */
export const connectorTrustId = (slug: string): string => `connector:${slug}`;
