# LUNORA BACKEND KNOWLEDGE BASE — REFERENCE

The rules are summarized in `backend/lunora/AGENTS.md`, which agents load automatically; this file holds the reasoning and detail. Paths are repo-relative.

## RUNTIME NOTES (Lunora on D1 vs Durable Objects)

Full detail in `backend/AGENTS.md` ("RUNTIME LESSONS"). The short version for
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
- **Per-user sharding** (`backend/AGENTS.md` → "Sharding and concurrency",
  per-user-sharding.md): requests land on the owner's shard. Code in
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
├── <module>/           # 38 feature folders, each with module.ts (defineModule)
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
| Table definitions   | `schema.ts`                               | `defineTable` from `lunorash/server`; 141 `defineTable` calls   |
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
(see `auth/AGENTS.md`). Rate limiting is opt-in per procedure:
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
   `TOO_MANY_REQUESTS`). 820 throw sites use it; nothing uses `CRPCError`.
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
   `/api/auth/*` limiter. Keep `get-session` exempt (see `apps/web/src/features/auth/AGENTS.md`).
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
`invitation`, `member`, `memberCredits`, `organization`, `organizationPolicies`, `passkey`,
`promptHistory`, `prompts`, `session`, `team`, `teamMember`, `teamSettings`, `twoFactor`, `user`,
`userSettings`, `verification`.

Trigger work runs inside the same mutation as the write: keep it bounded.
Deleting audited rows one at a time is required (a batched delete nests triggers
past the runtime's limit; see `backend/AGENTS.md`).

## COUNTS AND AGGREGATES

Counts are
`ctx.db.<table>.count({ where })`, which must be called on the owner's own rows
(it throws behind a read policy: `COUNT_RLS_UNSUPPORTED`; use `systemDb` for an
own-row count, per the RLS notes in `auth/AGENTS.md`).

## TRIGGERS MODULE

`triggers/` runs an agent on a schedule, a webhook, or an event (see `triggers/AGENTS.md`).

| File           | Holds                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema.ts`    | `triggers` (config, incl. cron expression, timezone, webhook secret) and `triggerExecutions` (log)                                                                                                                                                                                         |
| `functions.ts` | Public: `getTriggers`, `createTrigger`, `updateTrigger`, `setTriggerEnabled`, `deleteTrigger`, `getTriggerExecutions`, `testRunTrigger`. Internal: `getTriggerInternal`, `getDueScheduleTriggers`, `updateTriggerStats`, `createExecution`, `updateExecution`, `setTriggerEnabledInternal` |
| `schedule.ts`  | `checkDueTriggers` (internal mutation, batch of 25), the cron parser (`findNextCronTime`, `isValidCronExpression`) and `dueScheduleStep` (switches off an unarmable schedule). Run by the one-minute tick                                                                                  |
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

## AGENT COLUMNS

Long form of two `backend/lunora/agent/AGENTS.md` bullets.

**`messages.typedText`.** `text` stays the message as it was sent; `typedText` holds only what the person typed
(`typedTextColumn` over `typedTextOf`: no attachment, quote, guest note or placeholder) and is what the composer's prompt
search indexes (`typed_text_search`). Every writer of a user row's `text` sets it beside it: `addMessagesHandler`,
`updateMessage`, and `insertMessageRow`/`patchMessage` (`table-writes.ts`) for the others (the reply rewrite in
`branches.ts` edits assistant rows only). A new writer goes through one of them, or the index and `text` disagree. It is
server-only: not in `vMessageDocFields`, stripped by `publicMessage` from every message read; the search reads it as
`vTypedPromptRow` (`typedTextSearch`, `typedPromptRow`).

**Archived flag on thread vectors.** It is a row column because Lunora's vector sync writes metadata after commit, so
keeping it current is a row patch. A failed schedule from the threads update trigger fails the write; the job retries
forever, as nothing re-queues it. An idle shard is not swept. The backfill's place is on an `idempotencyClaims` row that
never expires, the chain's lease inside; only the step whose chain, kind and cursor equal the place runs, and nothing
runs once account deletion is underway. Writers read the thread's current status. Vectorize indexes a property only for
vectors written after its index; a failed upsert is logged, not retried (`lunora-upstream.md`).

## DOCUMENTATION & RESOURCES

- **Lunora**: `@lunora/*` packages, pinned in `pnpm-workspace.yaml` (`catalog:lunora`).
  The agent skills are in `.agents/skills/lunora*`.
- **Better Auth**: <https://better-auth.com>
- **`backend/AGENTS.md`**: runtime lessons and sharding; each feature folder's `AGENTS.md` holds its
  subsystem, and the root `AGENTS.md` lists them all.

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

## AGENT MODULE (`agent/`)

The rules are in `backend/lunora/agent/AGENTS.md`; the reasoning behind the longer ones is here.

### Grant revisions

- The count outlives the `threadAccess` row: a denial names the removal's revision, and a new grant continues past it,
  so a client can order a denial against a later re-grant.
- `getThreadBrowser`/`getHumanCheck` put the revision on every answer to a non-owner. The web cards drop answers below
  the highest revision seen (a lagging replica's read) and re-read an ask that was dropped.
- Claim and grant write are separate statements (D1 has no transaction across them): a change goes through `writeGrant`,
  conditional on the revision read; a new grant and a removal call `settleGrant` after their write, and a removal counts
  under the grantee the row names at that point. A denial reads the primary.
- A removal stamps the row with its revision's tombstone (negated, as a merge marks a copy) before the delete: a change
  that read the row earlier misses, one that reads it after answers the grant gone, so none lands in between and is
  erased while it reported a write. A stamped row grants nothing (`agent/live-grant.ts`: every access reader skips it),
  so a removal that stops between the stamp and the delete never leaves the grantee in; a re-grant writes a new row and
  deletes the stamped one, a later removal finishes it, and a merge never keeps one. Revision reads take the absolute value.
- Nothing keys `(threadId, userId)` unique on `threadAccess` (a merge from before `mergeGrantsPage` left copies, and
  concurrent accepts of one invite each insert one), so `settleGrant` reads the copies in pages until one comes back
  short, never trusting one page as all of them. Past `SETTLE_COPIES_MAX` it moves those and refuses (`CONFLICT`); the
  next settle reads the raised count and moves the rest.
- A guest merge marks the guest (`merged-guest` route) with its `merging` marker at every run's start (`beginMergeRun`),
  before any step reads the guest's rows; the grant steps run in `reassignGlobalRows` after its lease and erasure checks.
  `mergeGrantsPage` keeps one grant per chat: every write is
  conditional; a copy to delete is first marked with its negated revision, which no write takes; the kept row is read
  again before each delete; a chat with many copies is merged over several calls. Then the counts merge (a guest count
  is marked with its tombstone before its delete, and a claim that reads it goes to the merged account), and the mark is
  dropped after the guest (`deleteMergedGuest`, whose `grantsRemain` sends the run back to the `global` step), or with the
  `merging` marker by any stop that keeps the guest (`endGuestMerging`), whose grants then work as any account's.
- While the mark stands, a grant or count under the marked guest is refused or folded, and an invite of a marked owner
  waits. An accept the mark overtook takes its grant write back (`undoInviteGrant`), only at the revision it wrote, so
  it never removes a newer write. Its follow default goes the same way (`withdrawThreadFollowDefault`): a conditional
  stamp on the state and `updatedAt` written, then the delete. Every follow write is conditional on the `updatedAt` it
  read and leaves a later one (`setThreadFollowState`), and treats a stamped row as gone, so a choice made since stays.
  An invite to an accountless grantee or owner is refused (`requireAccounts`).
- A status read's denial of a grantee is decided again on the primary (a replica that has not seen a re-grant reads
  as the grant it is), and the count is read after that denial: the revision it names is then at least as new as the
  denial, so a re-grant and its removal landing between the two reads leave no grant answer the card keeps over it.
  The other order failed open; this one can only fail closed (a re-grant and a renewal landing between the reads label
  the denial past the re-grant's push, until a later read).
- A chat deleted for good is marked (`threadPurgeMarks`, `markThreadPurged`) before its purge reads a grant or a count.
  A new grant (`insertThreadAccess`) and a new count (`advanceGrantRevision`'s insert) read the mark from the primary
  AFTER their own write and take that write back when it is there. A write that misses the mark landed before it, so the
  purge's later reads find it; one that finds it was possibly missed and removes itself. An accept that read the invite
  before the delete can therefore leave nothing behind. The chat row cannot be checked instead: it lives on the owner's
  shard, the accept runs on the invitee's, and no transaction spans `.global()` writes. A change or removal of an
  existing grant needs no check: a patch of a purged row misses, and only an insert makes a row again. The mark names no
  user and is dropped a day after the purge finishes (`dropThreadPurgeMark`), past any write still in flight; one a
  lost job leaves is harmless.
- The rows stop growing with their chats and people: a chat deleted for good purges its counts (`revokeThreadGrantsPage`
  with `purge`), account erasure drains the user's held and given ones (`eraseGrantRevisionsForUser`). The export holds
  only the ones the user held (chat and revision); the counts on the user's own chats name other people and stay out.
  The export stores them a page per workflow step (`storeGrantRevisionsExportPage`, under the run's browser prefix, so
  the run's cleanup, the sweep and erasure take them) and the file action reads every page back; no step result or
  dispatch body carries them, and none is cut: past `GRANT_REVISIONS_EXPORT_PAGES` the export fails.
- Batched grant paths size each call to `GRANT_PAGE_STATEMENTS` (50 D1 statements); why 18 of the Free plan's 50 queries
  stay spare is in `lunora-upstream.md` (a `.global()` `patchIf` retries up to 16 rounds).

### Save rollback of stored files

- An approved tool result stores its media before its row saves; when the save fails, `discardUnsavedFiles` takes the
  files back. `chatFiles` rows are shared by hash, and a store that reuses one (`useExistingFile`, a racing `addFile`)
  does not count it: its message does, once it saves. So `refcount === 0` cannot tell "nobody wants it" from "another
  reply holds it until its save". Every reuse stamps `reusedAt`; the rollback deletes a row only when it is still as its
  store left it (`refcount` 0, no `reusedAt`).
- Lunora runs a mutation's `.global()` statements without a transaction, so that check is ONE conditional write: the
  delete marks the row (`patchIf` setting `discardingAt`, where `refcount`/`reusedAt` still match and no mark is set),
  then records the object, removes grants, export view (`deleteFileRowWithMetadata`) and row. A reuse (`claimForReuse`)
  and a new reference (`changeRefcount`) are `patchIf` on no mark too: one lands before the mark (the row stays, every
  grant with it) or finds it marked (a reuse stores its own row, a reference fails as "not found"). `findChatFile` skips
  marked rows. The sweep's `deleteFiles` goes through the same `discardFileRow`, conditional on `lastTouchedAt` and
  `refcount` 0.
- Every upload writes its OWN key, `agent-files/<sha256>/<uuid>` (`lib/chat-file-key.ts`); dedup is by row, never by
  key. A key is named only by the row its upload created and the stores that reused that row through the conditional
  reuse, so a rollback or sweep that marked the row deletes the object with no race: a store of the same bytes writes a
  key of its own, and a slow delete cannot reach it. Do not reintroduce content-addressed keys or holds.
- Every object delete is a `chatFileObjectDeletes` record, written in the deciding mutation right after the mark and
  ended once `ctx.storage.delete` returned (`deleteStoredObjects`). The hourly sweep claims records past `deleteAfter`
  (`retryObjectDeletes`, a page at a time), so a failed delete or a dead action never strands bytes.
- A store records its key as `kind: "store"` (`useExistingFile`'s `uploadKey`, due after `STORE_INTENT_MS`) BEFORE it
  uploads. `addFile` takes that record back with a conditional write as it writes the row; a key with no live `store`
  record is refused, so a row never names a key the sweep may delete. A store that lost to a racing store's row turns
  its record into a delete (`discardedUpload`) and deletes its own upload, never the row's.
- Rows stored before name the old shared `agent-files/<sha256>`. Those stay valid; their object goes only with the
  last row naming it (`isStorageKeyNamed`: every page of the hash from the primary; past the page cap the object is
  kept). No new row names an old key, so once none does, none will. Readers parse both forms (`chatFileKeyHash`).

### Archived flag on thread vectors

- Vectorize metadata on `embeddings-1024` only (metadata index in `alchemy.run.ts`). Lunora's vector sync writes it
  after commit, so keeping the flag current is a row patch on the thread's vector rows.
- The threads update trigger moves it on any change into or out of `archived`; a failed schedule fails the write, and
  the job retries forever, as nothing else re-queues it.
- The backfill runs once per shard, from the housekeeping sweep and from a meaning search (an idle shard is not swept).
  Its place is on an `idempotencyClaims` row that never expires, with the chain's lease inside; only the step whose
  chain, kind and cursor equal the place runs, and nothing runs once account deletion is underway.
- Writers read the thread's current status, patch only its own vectors of the same owner, and skip a thread gone or
  being deleted. Vectorize indexes a property only for vectors written after its index; a failed upsert is logged, not
  retried (`lunora-upstream.md`).
