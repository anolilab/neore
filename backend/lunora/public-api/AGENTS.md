# PUBLIC API — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Public v1 API + `neore` CLI** (`backend/lunora/public-api/`, `apps/cli`) —
  one route table (`routes.ts`) feeds both the hono router and
  `/api/v1/openapi.json`; every handler calls an EXISTING public procedure
  through `ctx.runQuery(api.…)`. That works because `server.ts`'s
  `resolveIdentity` resolves an API key to the key owner's `userId` on
  `/api/v1/*` ONLY (and nothing but a key there — no JWT, no cookie), so the
  procedure's own auth, access checks and limits run unchanged; scopes and the
  per-key limit are the router's job. **The runtime splits a resolved identity:**
  `userId` becomes `ctx.auth.userId` and `ctx.auth.getIdentity()` returns the
  OTHER claims without it — read both (`readApiKeyIdentity(claims, userId)`).
  The canonical key store is better-auth's `apikey` table (plugin rate limit
  OFF — its default is 10/day).
  `permissions` is server-only on `/api-key/create`, so scoped keys are minted by
  `auth_api_keys.createScopedApiKey`. `auth.api` is typed without plugin
  endpoints (`buildAuthOptions` returns plain `BetterAuthOptions`) — use
  `ApiKeyAuthApi` from `public-api/identity.ts`.
