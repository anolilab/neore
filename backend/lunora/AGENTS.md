# LUNORA BACKEND KNOWLEDGE BASE

The rules for working in `backend/lunora/`. Each section's detail and reasoning are in
[docs/agents/backend-lunora.md](../../docs/agents/backend-lunora.md).

## RUNTIME NOTES (Lunora on D1 vs Durable Objects)

- Database, sharding, queue, cron and `rateLimits` rules are in `backend/AGENTS.md`, which loads with this file.
- A shard's own key comes from `lib/shard-context.ts` (`currentShard`, `shardOf`).
- The test harness is one database for every shard (`test/setup-harness.ts`): cross-shard bugs show only in e2e.

## OVERVIEW

- Lunora (`@lunora/*`, `lunorash/server`): a Durable Object per user shard, D1 for `.global()` tables; `_generated/` is written by `pnpm codegen`.

## STRUCTURE

- `<module>/` feature folders each hold `module.ts` (+ `functions.ts`, `gdpr.ts` where it owns data); `lib/` holds shared helpers.
- Root files: `http.ts`, `crons.ts`, `queues.ts`, `workflows.ts`, `notify.ts`, `env.ts`, `schema.ts`. No `shared/`, `generated/` or top-level `pins/`.

## WHERE TO LOOK

- Tables `schema.ts`; ownership `<module>/module.ts`; builders `lib/crpc.ts`; rate limits `lib/rate-limiter.ts`; auth `auth.ts`, `auth/session.ts`.
- Services `lib/services.ts`; jobs `lib/job-queue.ts`, `lib/job-once.ts`; crons `crons.ts`; audit `lib/audit-triggers.ts`; storage `lib/storage-*.ts`, `lib/upload-route.ts`; RLS `lib/rls/`; GDPR `gdpr/`, `<module>/gdpr.ts`.

## BUILDERS (`lib/crpc.ts`)

- Build every client-reachable procedure from a `lib/crpc.ts` builder; auth is the builder choice (`authQuery`, `authMutation`, `adminAction`, …), not a flag.
- `action`/`publicAction` have no database access; `internal*` builders are server-only, with no auth.
- Rate limiting is opt-in: `.use(rateLimit("<name>"))` after `.input(...)`. Never add `requireDevelopment()` to a base builder.
- Throw `LunoraError` with a code from `lib/error-codes.ts` or the standard set; never `CRPCError`.
- Bound every list (`limit`, cursor, or `.page` on a named ceiling).
- Never put secrets in procedure args or returns: `_generated/api.ts` carries them to the client.

## INTER-PROCEDURE COMPOSITION

- Reference procedures through `api` (`_generated/api`) and `internal` (`_generated/internal`, nested by folder).
- A query/mutation needing another module's data calls that module's plain-function helper over `ctx.db`.
- `ctx.runMutation(internal.*)` from a mutation is a separate transaction; use it from actions.
- Actions never touch `ctx.db`; only `ctx.runQuery` / `ctx.runMutation` (`rls.guard.test.ts`).
- Queue work with `enqueueJob(ref, args)`; a paid or non-idempotent target with `{ once: true }`.

## IMPORTS (Cheat Sheet)

- Builders and `rateLimit` from `lib/crpc`; ctx types and raw builders from `_generated/server`; `v`, `defineSchema`, `defineTable`, `defineModule`, `LunoraError` from `lunorash/server`; `platformAdmin` from `@lunora/server`.
- Session helpers from `auth/session.ts`; service bindings from `lib/services.ts`.

## AUTH WIRING (`auth.ts`)

- Use the factories in `auth.ts` / `auth/` (`buildAuthOptions`, `buildAuth`, `getAuth`); never call better-auth directly.
- Guest conversion creates a NEW user; shard-local rows move via `lib/account-merge.ts`.
- Keep `get-session` exempt in `AUTH_RATE_LIMIT_CUSTOM_RULES`; run `auth.schema.test.ts` after any better-auth bump.

## TOON (Token-Oriented Object Notation) FOR TOOL OUTPUTS

- Tools encode structured output for the model in `toModelOutput` with `toonEncodeOutput` (`chat/tools/toon-encode.ts`).
- Do not pass `keyFolding`: the encoder ignores unknown options silently.

## AUDIT HISTORY

- Attach audit triggers from `lib/audit-triggers.ts` (`AUDIT_TABLES`, `auditTriggersFor` in `schema.ts`); they run in the writing mutation, so keep them bounded.

## COUNTS AND AGGREGATES

- `ctx.db.<table>.count({ where })` only on the owner's own rows (`COUNT_RLS_UNSUPPORTED` otherwise); use `systemDb` for an own-row count.

## TRIGGERS MODULE

- `triggers/` runs an agent on a schedule, webhook or event; see `triggers/AGENTS.md`.

## AUTO-CONTINUE (DEEP WORK MODE)

- `chat/lib/auto-continue.ts`: chat turns pass `getMaxSteps(isAutoContinue)`; `runHeadlessAgent` defaults to `getMaxSteps(true)`.

## PINS

- Message pins live in `chat/pins/functions.ts`; `threadPins` is owned by `chat/module.ts`. All are `authQuery` / `authMutation`.

## DOCUMENTATION & RESOURCES

- `@lunora/*` pinned via `catalog:lunora`; Better Auth: <https://better-auth.com>; each feature folder's `AGENTS.md` holds its subsystem.

## CONVENTIONS

- Cross-row invariants live in schema triggers, not per-mutation code.
- Stamp owner fields from `ctx.user`, never from args (`owner_field_from_args_not_auth`).
- Expected failures throw `LunoraError`; unexpected ones stay unhandled. Nothing secret in args, returns or descriptions.

## ANTI-PATTERNS

- Never run `lunora deploy` / `pnpm run deploy` or git commands unless explicitly instructed.
- Sensitive operations are `internal*`, never public; no secrets in code (environment variables or the vault).
- No external API calls from queries or mutations: use actions.
- Never return raw JSON to the LLM from tools (`toonEncodeOutput`).
- `_generated/`, `.global()` reads, cron expressions and `fetch` deadlines: see `backend/AGENTS.md`.
