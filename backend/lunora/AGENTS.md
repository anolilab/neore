# LUNORA BACKEND KNOWLEDGE BASE

**Generated:** 2026-01-23 20:32:15
**Updated:** 2026-10-10 (module map, shard routing, services)
**Parent:** ../../AGENTS.md

## RUNTIME NOTES (Lunora on D1 vs Durable Objects)

Full detail in the root `CLAUDE.md` ("RUNTIME LESSONS"). The short version for
anyone editing handlers here:

- `.global()` (D1) tables **cannot** use `ctx.db.query(t).withIndex(...)` — that
  reader is DO-only and throws at runtime. Use the facade:
  `ctx.db.<table>.findFirst({ where })` / `.findMany({ where, orderBy, limit })`.
  **This is caught by a test, not by the compiler.**
  `lib/global-table-reader.test.ts` reads the `.global()` tables out of `schema.ts`
  and fails naming the offending call site, so it follows a table that becomes
  `.global()` with no edit here.
- `findMany` with no `limit` returns EVERY matching row — it does not refuse an
  unsized scan, and `DEFAULT_LIMIT = 25` does not apply to it (verified by writing
  40 rows and reading 40 back). So an unbounded read IS complete. Use
  `findMany({ where }).then((r) => r.page)` when you want everything, a named
  ceiling constant when you do not. `findMany` always returns a `QueryPage`, so
  `.page` is required even unbounded.
- `ctx.db.<table>.findUnique({ where })` throws `NOT_UNIQUE` on a second match and
  takes neither `limit` nor `cursor`.
- Index `.eq()` on an unset column takes `null`; `undefined` produces invalid SQL.
- `ctx.db.patch` refuses `undefined` as a value. Use `lib/patch.ts` (`patchRow` /
  `patchById`: `undefined` removes a field; `withoutUndefined`: `undefined` leaves
  it unchanged).
- **Per-user sharding** (root `CLAUDE.md` → "Sharding and concurrency",
  docs/plans/per-user-sharding.md): requests land on the owner's shard. Code in
  a shard reads its shard from `lib/shard-context.ts` (`currentShard`,
  `shardOf`); an HTTP action wraps its handler with `lib/http-shard.ts`
  (`onCallerShard`, `inShard`, `onRoutedShard`); reaching another user's shard is
  `lib/cross-shard.ts#callOnShard`, from actions or HTTP only. In tests the harness
  is one database for every shard (`test/setup-harness.ts`), so cross-shard bugs
  do not show there — the e2e suite is what exercises routing.
- `rateLimits` is intentionally NOT `.global()` — `@lunora/ratelimit` reads it via
  the legacy builder and relies on the DO input gate for atomicity.

## OVERVIEW

Neore's backend on **Lunora** (`@lunora/*`, `lunorash/server` for the runtime
primitives) — Cloudflare Workers with Durable Objects per user shard, D1 for
`.global()` tables, real-time queries over WebSocket, Better Auth, AI integration,
GDPR workflows and audit history.

Source of truth is `backend/lunora/**`. `_generated/` is written by
`@lunora/codegen` (`pnpm codegen` in `backend/`) and is not edited by hand.

## STRUCTURE

```text
backend/lunora/
├── _generated/         # codegen output: api.ts, internal.ts, server.ts, dataModel.ts,
│                       #   functions.ts, queues.ts, workflows.ts, architecture.*, openapi.*
├── <module>/           # 35 feature folders, each with module.ts (defineModule)
│   ├── module.ts       # description + owned tables (metadata only)
│   ├── functions.ts    # public and internal procedures
│   ├── gdpr.ts         # erasure steps (where the module owns data)
│   └── ...
├── auth/               # Better Auth plugins, sessions, invitations, org/team, api keys
├── chat/               # threads, messages, streaming, tools, group chat, pins, tags
│   ├── lib/auto-continue.ts    # Deep Work: 25-step loop, context compression
│   ├── tools/toon-encode.ts    # TOON encoding for tool outputs
│   └── pins/functions.ts       # message pins (no separate pins/ folder)
├── lib/                # shared helpers (crpc, shard routing, services, jobs, storage, rls/)
├── http.ts             # the main Hono app; feature routes also live beside their code
│                       #   (e.g. triggers/http.ts, auth/*-http.ts)
├── crons.ts            # the one-minute `tick` and PERIODIC_JOBS
├── queues.ts           # jobs queue + DLQ (defineQueue literals)
├── workflows.ts        # @lunora/workflow definitions
├── notify.ts           # @lunora/notify (Web Push) configuration
├── env.ts              # ENVIRONMENT and other typed env reads
├── schema.ts           # single defineSchema(...) — the table definitions
└── lunora-bindings.json, lunora.config.ts (one level up, in backend/)
```

There is no `shared/`, `generated/` or `pins/` top-level folder.

## WHERE TO LOOK

| Task                | Location                                  | Notes                                                           |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Table definitions   | `schema.ts`                               | `defineTable` from `lunorash/server`; 131 `defineTable` calls   |
| Table ownership     | `<module>/module.ts`                      | `tables: [...]`; `lib/` and root files own none                 |
| Procedure builders  | `lib/crpc.ts`                             | `publicQuery`, `authQuery`, `authMutation`, `adminAction`, ...  |
| Rate limits         | `lib/rate-limiter.ts`                     | `RATE_LIMIT_CONFIGS`; `rateLimit("<name>")` middleware          |
| Auth options        | `auth.ts`                                 | `buildAuthOptions(hooks)`, `buildAuth(env)`, `getAuth()`        |
| Auth helpers        | `auth/session.ts`                         | `getAuthUserId`, `getAuthUserIdentity`, `getSession`            |
| HTTP routes         | `http.ts`                                 | Hono app; `/triggers/webhook/:triggerId`, `/chat/*`, uploads    |
| Chat features       | `chat/`                                   | `execute.ts` (agent run), `functions.ts`, `streaming/`          |
| Triggers            | `triggers/`                               | schedule / webhook automation; headless runs                    |
| Shard routing       | `lib/shard-*.ts`, `lib/cross-shard.ts`    | see RUNTIME NOTES                                               |
| Services (bindings) | `lib/services.ts`                         | `serviceFetch`, `gatewayFetch`, `isServiceBound`                |
| Jobs and queues     | `lib/job-queue.ts`, `lib/job-once.ts`     | `enqueueJob`, `runJobOnce`; config in `lib/job-queue-config.ts` |
| Cron tick           | `crons.ts`, `lib/cron-schedule.ts`        | add to `PERIODIC_JOBS`, not a new `crons.interval`              |
| Audit triggers      | `lib/audit-triggers.ts`                   | `AUDIT_TABLES`, `auditTriggersFor`                              |
| Storage             | `lib/storage-*.ts`, `lib/upload-route.ts` | private files, signed URLs, TUS uploads                         |
| Authorization (RLS) | `lib/rls/`                                | `policies.ts`, `scope.ts`; `docs/security/authz-matrix.md`      |
| GDPR                | `gdpr/`, `<module>/gdpr.ts`               | erasure must reach every table; see `gdpr/module.ts`            |
| Public API / CLI    | `public-api/`                             | one route table feeds the router and `/api/v1/openapi.json`     |
| Browser automation  | `browser/`                                | Cloudflare Browser Rendering sessions and actions               |
| Messenger           | `messenger/`                              | Telegram, Slack, Discord, WhatsApp, LINE, Feishu, Teams, WeChat |

## BUILDERS (`lib/crpc.ts`)

Every client-reachable procedure is built from one of these. Auth is the builder
choice, not a flag, so `ctx.user` is non-nullable on the authed variants.

| Builder                                                 | `ctx.user`             | Use for                                                           |
| ------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `query` / `publicQuery`                                 | none (`ctx.auth` only) | Reads that resolve identity themselves                            |
| `optionalAuthQuery`                                     | `SessionUser \| null`  | Public reads that personalise when signed in                      |
| `authQuery`                                             | `SessionUser`          | Default for authenticated reads (`authPaginatedQuery` aliases it) |
| `liteAuthQuery`                                         | `SessionUser`          | JWT-only reads (no session lookup) for hot paths                  |
| `adminQuery`                                            | `SessionUser`, admin   | Platform-admin reads                                              |
| `mutation`                                              | none (`ctx.auth` only) | Bare guarded mutation                                             |
| `publicMutation`                                        | `SessionUser \| null`  | Writes that may be anonymous                                      |
| `optionalAuthMutation`                                  | `SessionUser \| null`  | Anonymous-allowed writes                                          |
| `authMutation`                                          | `SessionUser`          | Default for authenticated writes                                  |
| `adminMutation`                                         | `SessionUser`, admin   | Platform-admin writes                                             |
| `action` / `publicAction`                               | none                   | External API calls; no database access                            |
| `authAction`                                            | `SessionUser`          | Authenticated actions                                             |
| `adminAction`                                           | `SessionUser`, admin   | Admin-only actions                                                |
| `internalQuery` / `internalMutation` / `internalAction` | none (no auth)         | Server-only; re-exported from `_generated/server`                 |

Every client-reachable builder ends in `withRlsScope` + `rowLevelSecurity()`
(see root `CLAUDE.md`). Rate limiting is opt-in per procedure:
`.use(rateLimit("<name>"))` after `.input(...)`. It counts the user when signed in,
otherwise the client IP. `requireDevelopment()` is opt-in too; never add it to a
base builder.

### Procedure shape

```typescript
// chat/pins/functions.ts (shape)
import { v } from "lunorash/server";

import { authMutation, authQuery, rateLimit } from "../../lib/crpc";

export const createPin = authMutation
    .use(rateLimit("pins/create"))
    .input({ messageId: v.string(), threadId: v.id("threads") })
    .output(v.string())
    .mutation(async ({ args, ctx }) => {
        // ...
    });
```

Procedure rules that matter:

1. Throw `LunoraError` with a code from `lib/error-codes.ts` or the standard set
   (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST`,
   `TOO_MANY_REQUESTS`). 651 throw sites use it; nothing uses `CRPCError`.
2. Bound every list with `limit`, a cursor, or `.page` on a named ceiling.
3. Declare `.output()` on every procedure. A declared output is authoritative for
   the generated type; `.output()` also rejects undeclared keys, so spread the full
   doc fields rather than re-listing a subset.
4. Never put secrets in procedure args or returns: the generated API surface
   (`_generated/api.ts`) carries every argument and return type to the client.

## INTER-PROCEDURE COMPOSITION

Procedures are referenced through the generated maps:

| Import                                | Use                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `api` from `_generated/api`           | Public procedures, e.g. `ctx.runQuery(api.agent.threads.getChildThreads, {...})`                   |
| `internal` from `_generated/internal` | Internal procedures; the namespace nests by folder (`internal.connectors.store.consumeOAuthState`) |

- A query or mutation that needs another module's data calls a **plain function**
  over `ctx.db` (the helpers in `agent/table-writes.ts`, `auth/lib/preference-writes.ts`,
  `browser/session-writes.ts`, `vault/lib/file-writes.ts`, `skills/template-skills.ts`).
  The write stays in the caller's transaction and shard.
- `ctx.runMutation(internal.*)` from a mutation is a separate transaction. Use it
  from an action, where that is the intent.
- Actions reach the database only through `ctx.runQuery` / `ctx.runMutation`; no
  action may touch `ctx.db` (`rls.guard.test.ts` pins it).
- Queued work goes through `enqueueJob(ref, args)` (`lib/job-queue.ts`); a paid
  or non-idempotent target is sent with `{ once: true }` so it runs through
  `lib/job-once.ts#runJobOnce`.

## IMPORTS (Cheat Sheet)

| Need                                                              | Import from                                  |
| ----------------------------------------------------------------- | -------------------------------------------- |
| `query`, `mutation`, `action`, `internal*`                        | `_generated/server` (usually via `lib/crpc`) |
| `QueryCtx`, `MutationCtx`, `ActionCtx`                            | `_generated/server`                          |
| Procedure builders and `rateLimit`                                | `lib/crpc`                                   |
| `v`, `defineSchema`, `defineTable`, `defineModule`, `LunoraError` | `lunorash/server`                            |
| `platformAdmin`                                                   | `@lunora/server`                             |
| `api` / `internal` references                                     | `_generated/api`, `_generated/internal`      |
| Better Auth session helpers                                       | `auth/session.ts`                            |
| Service bindings                                                  | `lib/services.ts`                            |
| Public API types                                                  | `_generated/api.ts` (generated)              |

## AUTH WIRING (`auth.ts`)

```typescript
// auth.ts (shape)
export const buildAuthOptions = (hooks: AuthOptionHooks = {}): BetterAuthOptions => { ... };
export const buildAuth = (env: AuthEnv) => createAuth(...);
export const getAuth = () => ...;
export default buildAuth;
```

Auth contract:

1. Use the factories in `auth.ts` and `auth/`; do not call better-auth directly.
2. `AuthOptionHooks.onGuestConverted` runs when an anonymous user converts to a
   real account. Conversion creates a NEW user, so the guest's shard-local rows are
   moved by `lib/account-merge.ts`.
3. `AUTH_RATE_LIMIT_CUSTOM_RULES` sets per-path overrides for better-auth's
   `/api/auth/*` limiter. Keep `get-session` exempt (see root `CLAUDE.md`).
4. `auth/module.ts` lists the Better Auth tables it owns. `auth.schema.test.ts` checks the
   hand-maintained copies in `schema.ts` against the plugins `buildAuthOptions`
   installs; run it after any better-auth bump.

## TOON (Token-Oriented Object Notation) FOR TOOL OUTPUTS

Chat tools return TOON-encoded text to the model, so uniform arrays cost fewer
tokens. The UI still gets the full JSON from the tool's `handler`.

```typescript
// chat/tools/toon-encode.ts (default export)
const toonEncodeOutput = (output: unknown) => ({ type: "text" as const, value: encode(output) });
export default toonEncodeOutput;
```

Tools call it from `toModelOutput`. Some tools build a prompt string instead
(e.g. the translate tool) and skip TOON. Do not pass `keyFolding`: the encoder
ignores unknown options silently.

## AUDIT HISTORY

Change tracking for GDPR is done by schema triggers from `lib/audit-triggers.ts`.
`AUDIT_TABLES` maps each tracked table to its attribution (how the owning user
is read from the document). `schema.ts` attaches them with
`.triggers((t) => auditTriggersFor(t, "<table>", AUDIT_TABLES["<table>"]!))`.

Tracked tables: `account`, `aiUserPreferences`, `files`, `folders`, `gdprConsent`,
`invitation`, `member`, `memberCredits`, `organization`, `passkey`, `promptHistory`,
`prompts`, `session`, `team`, `teamMember`, `teamSettings`, `twoFactor`, `user`,
`userSettings`, `verification`.

Trigger work runs inside the same mutation as the write: keep it bounded.
Deleting audited rows one at a time is required (a batched delete nests triggers
past the runtime's limit; see root `CLAUDE.md`).

## COUNTS AND AGGREGATES

Counts are
`ctx.db.<table>.count({ where })`, which must be called on the owner's own rows
(it throws behind a read policy: `COUNT_RLS_UNSUPPORTED`; use `systemDb` for an
own-row count, per the RLS notes in root `CLAUDE.md`).

## TRIGGERS MODULE

`triggers/` runs an agent on a schedule, a webhook, or (not yet) an event.

| File           | Holds                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.ts`    | `triggers` (config, incl. cron expression, timezone, webhook secret) and `triggerExecutions` (log)                                                                                                                                                                                         |
| `functions.ts` | Public: `getTriggers`, `createTrigger`, `updateTrigger`, `setTriggerEnabled`, `deleteTrigger`, `getTriggerExecutions`, `testRunTrigger`. Internal: `getTriggerInternal`, `getDueScheduleTriggers`, `updateTriggerStats`, `createExecution`, `updateExecution`, `setTriggerEnabledInternal` |
| `schedule.ts`  | `checkDueTriggers` (internal mutation, batch of 25) and the 5-field cron parser (`getNextCronTime`, `isValidCronExpression`). Run by the one-minute tick, not its own cron                                                                                                                 |
| `execute.ts`   | `executeTrigger` (internal action): runs `runHeadlessAgent` (`chat/lib/headless-run.ts`) in a new thread, then logs the execution                                                                                                                                                          |
| `http.ts`      | `POST /triggers/webhook/:triggerId`; `verifyHmacSignature` (HMAC-SHA256, GitHub-style `sha256=hex` and raw hex)                                                                                                                                                                            |

## AUTO-CONTINUE (DEEP WORK MODE)

`chat/lib/auto-continue.ts` extends the AI SDK loop for multi-step work.

| Export                                               | Purpose                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `getMaxSteps(shouldAutoContinue, modelDefault = 5)`  | `DEFAULT_AUTO_CONTINUE_CONFIG.maxIterations` (25) when on, else `modelDefault` |
| `estimateTokens(messages)`                           | Fast ~4 chars/token estimate                                                   |
| `getModelContextWindow(id)`                          | Context window lookup by model ID                                              |
| `compressContextMessages()`                          | Summarise older messages near the context limit                                |
| `applyLateCompression()`                             | Compression applied just before a model call                                   |
| `isContextExceededError()`                           | Detects the provider's context-overflow error                                  |
| `AutoContinueConfig`, `DEFAULT_AUTO_CONTINUE_CONFIG` | Config (maxIterations, threshold)                                              |
| `AutoContinueStreamEvent`                            | SSE event types for frontend progress                                          |

Triggers use `runHeadlessAgent`, which defaults to `getMaxSteps(true)`. Chat
turns pass `getMaxSteps(isAutoContinue)` from `chat/execute.ts`.

## PINS

Message pins live in `chat/pins/functions.ts` (module `chat`). The `threadPins`
table is in `schema.ts` and is owned by `chat/module.ts`.

| Function                | Type     | Notes                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------- |
| `getThreadPins`         | Query    | Pins for a thread                                                      |
| `createPin`             | Mutation | Rate-limited (`pins/create`); anchors a message and optional selection |
| `updatePinNote`         | Mutation |                                                                        |
| `updatePinSelectedText` | Mutation |                                                                        |
| `deletePin`             | Mutation |                                                                        |

All five are `authQuery` / `authMutation`.

## DOCUMENTATION & RESOURCES

- **Lunora**: `@lunora/*` packages, pinned in `pnpm-workspace.yaml` (`catalog:lunora`).
  The agent skills are in `.agents/skills/lunora*`.
- **Better Auth**: <https://better-auth.com>
- **Root `CLAUDE.md`**: runtime lessons, sharding, billing, auth and the other
  subsystems this file does not repeat.

## CONVENTIONS

- **Schema-first invariants**: cross-row invariants live in schema triggers, not in
  per-mutation code paths.
- **Bounded reads**: every `findMany` has `limit`, a cursor, or a named ceiling.
- **Ownership from `ctx.user`**: stamp owner fields from the resolved user, never
  from args (`owner_field_from_args_not_auth` is an ERROR).
- **Module ownership**: each table is listed by exactly one `module.ts`; a write
  into another module's table goes through that module's write helpers.
- **Errors**: expected failures throw `LunoraError`; unexpected ones stay unhandled.
- **Meta is public**: nothing secret goes into args, returns or descriptions, since
  `_generated/api.ts` carries them to the client.
- **TOON for tool outputs**: tools returning structured data encode them in
  `toModelOutput` with `toonEncodeOutput`.

## ANTI-PATTERNS

- Never run `lunora deploy` or `pnpm run deploy` unless explicitly instructed —
  CI owns deployment.
- Never run git commands unless explicitly instructed.
- Don't expose sensitive operations as public functions; use `internal*`.
- Don't call external APIs from queries or mutations — use actions, and give every
  outbound `fetch` a deadline (`lib/fetch-timeout.ts`).
- Don't store secrets in code — use environment variables or the vault.
- **Don't edit `_generated/` by hand** — `pnpm codegen` rewrites it.
- **Don't return raw JSON to the LLM** from tool outputs — use `toonEncodeOutput`.
- **Don't read `ctx.db.query(t).withIndex` on a `.global()` table** — use the
  `ctx.db.<table>` facade.
- **Don't add a second cron expression** — periodic work goes in `PERIODIC_JOBS`.
