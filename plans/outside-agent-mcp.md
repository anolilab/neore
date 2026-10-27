# Outside-agent MCP server

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
S1 has no dependencies. The write slice's host-thread test needs a host-run
thread from [acp-agent-host.md](acp-agent-host.md) S3.

## 1. Goal and decision

MCP clients such as Claude Code and Codex can connect to a user's Neore account.
They list and read threads, search knowledge and read tasks. With a write-scoped
key, they also send messages and start threads. Read-only is the default.

**Decision.** The MCP server is a thin layer over the public v1 API
(`backend/lunora/public-api/`). Its tools are generated from the one route table
(`routes.ts`) that already feeds the hono router and `/api/v1/openapi.json`.
Every tool call runs through the same router path as a REST call, so scopes, the
per-key rate limit, idempotency, shard routing and locked-thread handling apply
unchanged. v1 auth is scoped API keys. OAuth is v2, built on the extension-grant
pattern. Writes into host-run threads are refused server-side, in
`runChatStart`, the turn-start path that REST and MCP both reach.

## 2. Current state (checked)

- `backend/lunora/public-api/identity.ts`: on `/api/v1/*`, `resolveIdentity`
  accepts an API key and nothing else: no JWT, no cookie.
- `backend/lunora/public-api/scopes.ts`: resources `chat`, `threads`, `skills`,
  `tasks`, `knowledge`, `memories`, `models`; actions `read`, `write`. **`write`
  does not imply `read`.** The default scope set is read-only on everything.
  Scoped keys are minted by `auth_api_keys.createScopedApiKey`.
- `backend/lunora/public-api/routes.ts`: `ROUTES`, each with `method`, `path`,
  `scopes`, `operationId` and a handler that calls an existing procedure through
  `ctx.runQuery` / `runMutation`. Paths: `GET /me`, `GET /models`,
  `POST /chat` (`chat:write`; creates a thread unless `threadId` is given;
  `stream: false` blocks up to 5 minutes), `POST /chat/stream`,
  `GET /threads`, `GET|DELETE /threads/{threadId}`,
  `GET /threads/{threadId}/messages`, `GET /skills`,
  `POST /skills/{skill}/run`, `GET|POST /tasks`, `GET /tasks/{taskId}`,
  `POST /tasks/{taskId}/run`, `GET|POST /knowledge/files`,
  `GET /knowledge/search`, `GET /memories`. **There is no thread search route.**
- `backend/lunora/public-api/router.ts`: `authenticate`, `missingScopes`,
  `applyKeyRateLimit` (`publicApi/read` and `publicApi/write` families, by key
  id), body cap `MAX_BODY_BYTES`, then `inShard(..., identity.userId, ...)` and
  `handleOnShard`.
- `backend/lunora/public-api/idempotency.ts`: the `Idempotency-Key` header on
  POST routes replays the first response, scoped by API key id, for 24 h.
- The thread read routes (detail, messages, list) answer not found for a locked
  thread (`thread-lock.test.ts`). `DELETE /threads/{threadId}` does not: its handler
  calls `deleteThread`, which checks ownership only. Open item before any thread
  route gets an `mcp` tag: make the DELETE handler load the thread through
  `notFoundIfLocked` first. No thread route gets a tag until every one of them
  refuses a locked thread.
- Key creation UI with a scope picker exists:
  `apps/web/src/features/auth/components/settings/api-key/create-api-key-dialog.tsx`,
  `api-key-scope-picker.tsx`.
- Neore is an MCP client today (connectors, MCP servers in chat). It has no MCP
  server.

## 3. Design

### Endpoint

- `POST /api/v1/mcp`, mounted inside `createPublicApiRouter`, so it shares the
  prefix and `authenticate`. Transport and protocol version follow the published
  MCP spec at S1. The handler answers `initialize`, `tools/list` and
  `tools/call`, and nothing else in v1 (no resources, no prompts, no sampling).
- The endpoint itself is not a `ROUTES` entry. It is a dispatcher over them.

### Tools generated from routes

- `RouteDefinition` gains an optional `mcp: { tool: string; description: string }`.
  Only routes that carry it become tools. The tool's input schema is the route's
  path parameters, query and body schemas, taken from what the OpenAPI builder
  already reads.
- `tools/list` returns only the tools whose route scopes the calling key holds,
  so a read key never sees write tools. This is a convenience; the check that
  counts is the next point.
- `tools/call` is refactored out of `handle`: it resolves the route, runs
  `missingScopes` (refusal is `insufficient_scope`, not a 500),
  `applyKeyRateLimit` with the route's read or write flag, and idempotency, then
  `handleOnShard`. One code path for REST and MCP.
- A tool's optional `idempotencyKey` argument feeds the same store as the
  `Idempotency-Key` header.

| Tool | Route | Scope | Slice |
| --- | --- | --- | --- |
| `list_threads` | `GET /threads` | `threads:read` | S1 |
| `get_thread` | `GET /threads/{threadId}` | `threads:read` | S1 |
| `read_messages` | `GET /threads/{threadId}/messages` | `threads:read` | S1 |
| `search_knowledge` | `GET /knowledge/search` | `knowledge:read` | S1 |
| `list_tasks`, `get_task` | `GET /tasks`, `GET /tasks/{taskId}` | `tasks:read` | S1 |
| `create_thread` | `POST /chat` without `threadId` | `chat:write` | S2 |
| `send_message` | `POST /chat` with `threadId` | `chat:write` | S2 |

- `send_message` and `create_thread` call `POST /chat` with `stream: false` and
  return the final reply text with its `threadId` and `messageId`. If the reply
  outlasts the client's tool timeout, the client reads it later with
  `read_messages`.
- Thread search is not in v1, because no route exists. Adding one is its own
  public-API change first, with its own OpenAPI entry, and then an `mcp` tag.

- If a run pauses for a person (an `ask` tool), the call returns
  `waiting_on_person` with the pending request, not an empty result. Messages from an
  outside agent are recorded as such, and a run it starts never gets more than `ask`
  for its tools.

### What an outside agent may not do

- **No writes into host-run threads.** `runChatStart`
  (`backend/lunora/chat/http.ts`) refuses any thread where `isHostRunThread` is
  true ([acp-agent-host.md](acp-agent-host.md) §5.2). Both `/chat/start` and
  `POST /api/v1/chat` (`startChat` in `routes.ts`) call it, so REST and MCP are
  both refused there, server-side, with a stable error code
  (`host_thread_read_only`) mapped by `errors.ts`. A tool description saying so
  is documentation, not the check. Reads of host-run threads are allowed.
- **No device or host commands.** No route exposes device calls, ACP commands or
  permission answers, and none gets an `mcp` tag. A prompt from an outside agent
  can never answer a permission request. `/hosts/send` and the ACP procedures live
  outside `/api/v1`, where an API key resolves to no identity.
- **No indirect host writes.** A `send_message` into a cloud lead thread cannot
  drive a host worker: dispatch to a host worker always runs in `ask` mode and
  needs a click in the app ([agent-orchestrator.md](agent-orchestrator.md) §4).
- **No consent changes.** Nothing here can add an ACP agent or folder.
- **No scope escalation.** The router checks the route's scopes for every call,
  whatever `tools/list` returned.
- **No new procedures.** Tool calls go through routes, which call existing
  procedures. So the MCP layer adds no rows to `docs/security/authz-matrix.md`.
  Any procedure a later slice does add (for example a key list with last-used
  time) gets its row, enforced by `backend/lunora/authz-matrix.guard.test.ts`.

### Content handling

- Thread content is returned as structured data (`role`, `author`, `createdAt`,
  `text`), never as free text merged into the tool result. Every tool
  description states that message text is user-written data, not instructions.
- Results are capped per call (the route's pagination). A long thread is read in
  pages.

### Auth, v1 and v2

- **v1:** a scoped API key from settings, pasted into the client's MCP config as
  a bearer header. The UI defaults to read-only.
- **v2 (S4):** OAuth for hosted MCP clients, built on the authorization-code and
  PKCE flow of `backend/lunora/auth/extension-grant.ts`. The grant mints a
  scoped API key for the client rather than a session, so `/api/v1/*` still
  accepts keys only. No second token system.

## 4. Touchpoints

- `backend/lunora/public-api/router.ts`: the `/mcp` route; `handle` split into
  "authenticate" and "run route for identity".
- `backend/lunora/public-api/routes.ts`: `mcp` tags on the routes above.
- New `backend/lunora/public-api/mcp.ts`: JSON-RPC framing, `tools/list`,
  `tools/call`.
- `backend/lunora/public-api/openapi.ts`: documents `/mcp` and the tool tags.
- `backend/lunora/public-api/errors.ts`: `host_thread_read_only`.
- `backend/lunora/chat/http.ts` (`runChatStart`): the host-thread refusal,
  landed by ACP S3.
- `apps/web/src/features/auth/components/settings/api-key/`: a copyable MCP
  config snippet after creation.

## 5. Slices

**S1 — Read tools.** The endpoint, `tools/list`, `tools/call`, the S1 tools.
- Acceptance: a read-scoped key lists and reads a thread from an MCP client
  config; `tools/list` for a read key contains no write tool; a forced
  `tools/call` of `send_message` with a read key answers `insufficient_scope`; a
  locked thread is not found through `get_thread` or `read_messages`; MCP calls consume the same
  `publicApi/read` limit as REST.

**S2 — Write tools.** `create_thread`, `send_message`, `idempotencyKey`.
- Acceptance: the same `idempotencyKey` twice creates one message; a key with
  `chat:write` but no `threads:read` can send but cannot list; a send counts
  against the daily message limit like any chat turn; `send_message` and
  `POST /api/v1/chat` into a host-run thread (fixture with `runner: "host"`)
  both answer `host_thread_read_only`.

**S3 — Key UI.** Config snippet, last-used time in the key list, immediate
revocation.
- Acceptance: a revoked key is refused on its next MCP call; the snippet's header
  name matches what `authenticate` reads.

**S4 — OAuth (v2).** Only after S1–S3 have users (§9 Q1).

## 6. Invariants

- `/api/v1/*` admits API keys only, and the MCP endpoint is under it.
- Scopes are checked by the router on every call. `write` does not imply `read`.
- Per-key rate limits and idempotency apply to MCP as to REST.
- The host-thread refusal is in `runChatStart`, not in the MCP layer.
- Routes run on the key owner's shard (`inShard`). `threadShardFor` already
  routes a shared thread to its owner.
- Actions never touch `ctx.db`. Handlers keep calling procedures.

## 7. Risks

- **Prompt injection through thread content.** Mitigated by structured results
  and tool descriptions (§3). It is not eliminated: the outside agent's own
  handling decides the rest.
- **A leaked key** reads at its scope until revoked. Keys are shown once,
  revocable, and show last use (S3).
- **A second send path.** Writes are scoped, rate-limited and charged like app
  sends. §9 Q2 adds a visible source.
- **Long blocking sends** hold an HTTP action up to the route's 5-minute bound.
  This is acceptable because the route already does it for REST.

## 8. Not in v1

Resources, prompts and sampling; task writes (`POST /tasks`, `/tasks/{id}/run`);
skill runs; knowledge uploads. Each can be added later by tagging its route,
once a user asks.

## 9. Open questions

1. **OAuth (S4).** Recommendation: build only after v1 keys have users, and only
   for clients that cannot take a static header.
2. **Visible source on outside writes.** Recommendation: yes. A message sent
   through a key shows "via API key `<name>`". That needs a field on the message
   row, written through the agent write surface; decide at S2.
3. **Task writes as tools.** Recommendation: after S2, behind `tasks:write`, once
   the write path has run in production.
