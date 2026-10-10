# Connectors

Third-party services (Notion, GitHub, Slack, Google Drive, Gmail) reached through
each provider's **own hosted remote MCP server**, authorised with OAuth 2.1 +
PKCE. There is no proxy Worker and no per-connector Worker: a connector is a row
in `connectorDefinitions` pointing at an MCP URL, and its tools join chat through
the ordinary MCP path.

## Files

| File                               | Role                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| `oauth.ts`                         | `startConnectorOAuth` / `completeConnectorOAuth` (auth actions)                                  |
| `mcp-servers.ts`                   | Sign-in to the user's OWN MCP servers: start (or ask to confirm), sign out, list                 |
| `user-connectors.ts`               | `listConnectorCatalog` (settings page), `disconnectConnector` (revokes), secret-free reads       |
| `store.ts`                         | Internal persistence: flow state, grants, compare-and-set refresh                                |
| `seed.ts`                          | The catalogue, upserted by slug — `lunora run connectors_seed:seed`                              |
| `lib/mcp-oauth.ts`                 | Generic MCP-spec OAuth client: PRM + AS discovery, DCR, PKCE, token/refresh/revoke               |
| `lib/grant-runtime.ts`             | Stored grant → `MCPServerConfig` with a fresh bearer token (refresh, rotation, expiry)           |
| `lib/token-crypto.ts`              | AES-GCM for tokens; `CONNECTOR_ENCRYPTION_KEY`, else `ENCRYPTION_KEY` under its own HKDF purpose |
| `lib/client-config.ts`             | Pre-registered clients from env (`<PREFIX>_CLIENT_ID/_SECRET`), redirect URI                     |
| `lib/validators.ts`                | The OAuth client record, flow, target and grant-reference shapes — the schema imports these      |
| `lib/authorization-server-site.ts` | Same-site rule for a user's own server's authorization server (see below)                        |

## Flow

1. The settings page calls `startConnectorOAuth({ connectorSlug })`. It discovers
   the authorization server from the MCP server (401 `WWW-Authenticate` →
   protected-resource metadata → RFC 8414/OpenID metadata; spec fallbacks when
   absent), picks a client (env, or Dynamic Client Registration), stores a
   single-use `state` (SHA-256 only) bound to the user with the encrypted PKCE
   verifier, and returns the authorization URL.
2. The provider redirects to the **app** route
   `/dashboard/settings/connectors/callback`, which is signed in and calls
   `completeConnectorOAuth({ code, state })`. The state must belong to the
   caller, be unexpired (10 min) and unused. A backend HTTP callback would have
   no session to check against — the browser authenticates to the backend with
   a bearer JWT that a redirect does not carry.
3. Tokens are stored encrypted on `userConnectors`. Each agent run
   (`chat/lib/agent-tools.ts`) turns connected grants into MCP servers, refreshing
   tokens inside a 5-minute skew window. Tools are keyed
   `connector:<slug>:<tool>` and default to `ask` unless the server marks them
   `readOnlyHint`.
4. Disconnect and GDPR deletion revoke at the provider (RFC 7009, or GitHub's /
   Slack's own endpoints), best-effort, then drop the secrets.

A user's OWN server can name any authorization server in its protected-resource
metadata — Notion's, say, so the user approves on Notion's real consent screen
and the token goes to the attacker's URL. So for those servers every
authorization-server endpoint must share the MCP server's registrable domain;
otherwise `startMcpServerOAuth` answers `confirm` with both hosts, BEFORE any
client registration, and proceeds only when the user trusts exactly those hosts.
The trust is kept on the grant (`trustedAuthorizationServerHosts`). Catalogue
connectors are exempt: their pairing is the operator's claim, not the server's.
Authorization-server metadata must also name the issuer it was fetched for
(RFC 8414 §3.3).

Every URL a server hands back is checked with `validateDomain` (https, no private
or metadata addresses) before it is fetched or sent to the browser, and fetches
do not follow redirects.

## Operator setup

| Connector     | Needs                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Notion        | Nothing — DCR.                                                                                            |
| GitHub        | OAuth App → `GITHUB_CONNECTOR_CLIENT_ID/SECRET` (CI secrets `CONNECTOR_GITHUB_CLIENT_ID/SECRET`).         |
| Slack         | Slack app (Marketplace-listed or workspace-internal) → `SLACK_CONNECTOR_CLIENT_ID/SECRET`.                |
| Drive / Gmail | Google Cloud "Web application" client, Workspace Developer Preview → `GOOGLE_CONNECTOR_CLIENT_ID/SECRET`. |

Register `${SITE_URL}/dashboard/settings/connectors/callback` as the redirect URI
with each. A connector whose client id is unset shows as "not configured".
Endpoints and their sources are listed in `seed.ts`.
