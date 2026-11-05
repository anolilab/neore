# CONNECTORS — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Connectors** (`backend/lunora/connectors/`) — each is a row pointing at the
  provider's OWN hosted MCP server; OAuth is discovered from that server
  (`lib/mcp-oauth.ts`, generic MCP-spec client: PRM → AS metadata → DCR or an
  env client → PKCE). The provider redirects to the APP route
  `/dashboard/settings/connectors/callback`, not the backend, because
  completion must run as the signed-in user to check the `state` owner — a
  top-level redirect carries no bearer JWT. Connected grants join chat as MCP
  servers keyed `connector:<slug>:<tool>`. GitHub Actions reserves secret names
  starting `GITHUB_`, so `GITHUB_CONNECTOR_*` is fed from `CONNECTOR_GITHUB_*`.
