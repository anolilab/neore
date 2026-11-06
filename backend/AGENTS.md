# BACKEND (LUNORA PLATFORM) KNOWLEDGE BASE

The rules for working in `backend/`. Each section's detail and reasoning are in
[docs/agents/backend.md](../docs/agents/backend.md); project-wide rules stay in the root `AGENTS.md`.

## LUNORA (CODE COMPLETE — AWAITING FIRST DEPLOY)

- `backend/lunora/**` is the source of truth. No data to migrate; the first deploy is CI's job.
- Upstream issues (and what must not be re-filed), advisor findings and duplicate `@lunora/*` copies: `docs/agents/lunora-upstream.md`.

## SERVICE BINDINGS

- **Services (service bindings)**: declared in `backend/lunora.config.ts`, read statically (inline string literals only; `dir` relative to `backend/`). Do not declare `embeddings`.
- `ctx.services` exists on ACTIONS only. Thread a `ServiceFetch` down (`lib/services.ts`: `gatewayFetch`, `serviceFetch`, `gatewayFetchFor`); `getAgent`/`getUtilityModel` require it; non-actions pass `NO_SERVICE_FETCH`. Never cache a client at module level.
- Never pass `ctx.services.x.fetch` detached (`Illegal invocation`): use `serviceFetch`. Probe optional services with `isServiceBound`.
- The backend binds the gateway's `InternalApi` entrypoint, never its default `fetch`; keep `app.use("/internal/*", internalAuth)` blanket.
- Do NOT declare that entrypoint in `lunora.config.ts`; its `services[]` entry in `backend/wrangler.jsonc` is hand-written and kept out of `package.json#lunora.services`.
- Lunora writes the other `services[]` entries on `dev`/`prepare`/`build`, not `codegen`: after editing `lunora.config.ts`, run `pnpm --filter @neore/backend run prepare:deploy` and commit both files.
- Alchemy binds the same names by hand in `alchemy.run.ts` (private Workers `workersDev: false`); `deploy-env-bindings.test.ts` pins config ↔ wrangler ↔ alchemy.
- `@lunora/testing`'s action ctx has no `services`: mock `lib/services` in harness suites, or use a fake `Fetcher`.
- Dev runs two gateways (binding target inside `lunora dev`, standalone on :8787); migrate the usage D1 for both.
- No `ai` binding at the top level of a service's `wrangler.jsonc`; only in `env.production` / `env.preview`.
- document-parser is a Rust Worker: its `build.command` stays `pnpm --filter document-parser run build:worker`; starting the backend needs the Rust toolchain unless `services/document-parser/build/` exists. The 25 MB cap must agree in `src/shape.rs` and `lib/document-limits.ts`.

## Codegen

```bash
cd backend && pnpm codegen     # lunora codegen, then backend/scripts/check-generated.mjs
```

- Never edit `_generated/`; fix non-compiling output in a `.d.ts`, our source, or upstream.
- Functions load lazily: every builder chain must be statically traceable to a `_generated/server` factory (`const` alias, not `export … from`); `.expose()`/`.x402()` take literals. Registry tests call `loadAllFunctions()` first.
- A cold pass (`rm -rf lunora/_generated && pnpm codegen`) is reproducible, but restart a running vite after it.
- After a clean codegen, typecheck BOTH backend and `apps/web`.
- Use the wrappers (`pnpm --filter @neore/backend run build` / `run prepare:deploy`), not bare `lunora build` / `lunora prepare`.
- The advisor is an exit gate that fails before the post-codegen step; run it with `pnpm --filter @neore/backend run lunora:advise`.

## Modules

- Every feature folder has a `module.ts` (`defineModule`), metadata only; modules do not nest; root files and `lib/` are outside any module.
- A new table goes in exactly one module's `tables` (shared infra tables stay unowned).
- Write into another module's table only through its write surface (plain functions over `ctx.db`, e.g. `agent/table-writes.ts`); `ctx.runMutation(internal…)` only from an action. Patches go through `withoutUndefined`.
- Those helpers hide inserts from `owner_field_from_args_not_auth`: stamp ownership from `ctx.user` before calling one.
- GDPR: each module erases its own tables in `<module>/gdpr.ts`; `gdpr/batch.ts` helpers take the delete as a callback. Any `cross_module_table_write` is a regression.
- `_generated/architecture.*` is git-ignored: a new job running bare `tsc`/`vitest` in `backend/` must run `pnpm codegen` first.

## Validators: `v` vs zod

- zod only for AI SDK `inputSchema`/`generateObject`; never to declare a Lunora validator.
- `v` differences: `.check()` for refinements; `.safeParse()` returns `{ ok, value }`; no `enum` (union of literals); no `.strict()`/`.extend()`/`looseObject`; `.default()` is a column default, so use `v.optional` and default in the handler.
- `.output()` REJECTS undeclared keys: spread the full doc fields (`{ ...vThreadDocFields }`), never a hand-listed subset.
- A bare `v.any()` is an optional key; write `v.optional(v.any())` only for truly optional fields.
- Codegen cannot read a bare const reference, `v.object(fieldsConst)` or a call: inline or spread (`v.object({ ...fieldsConst })`). A call in `.input()` yields an empty argument shape (`lib/argument-shapes.guard.test.ts`).
- Trust a typecheck's exit code, never an error count: run `pnpm lint:types` to completion.
- Declare `.output()` on every procedure; otherwise import types from the declaring module, never a barrel.

## RUNTIME LESSONS (D1 vs DO)

- `tsc` clean is not "works": the rules below all typechecked and failed at runtime. Drive the app to verify.

## Database access

- `.global()` tables: never `ctx.db.query(t).withIndex(...)`; use `ctx.db.<table>.findFirst/findMany` (`lib/global-table-reader.test.ts`).
- `findMany` without `limit` returns every row and always a `QueryPage` (`.page`); test past 25 rows before claiming read completeness. `findUnique` throws `NOT_UNIQUE`, takes no `limit`/`cursor`.
- Index `.eq()` takes `null`, never `undefined` (`args.x ?? null`).
- Never pass `undefined` (or `null` for a `v.optional` column) to `ctx.db.patch`: use `lib/patch.ts` (`patchRow`/`patchById`, `withoutUndefined`).
- `.global()` D1 tables are created lazily: exercise the route before checking `sqlite_master`; drop the `globalSchemaMarker` row if you drop a table by hand.
- `lunora build` gates schema drift against `backend/lunora/.lunora-schema.json`: commit it with schema changes; with data at rest, widen → migrate → narrow.
- Delete rows of `AUDIT_TABLES` one at a time, never `Promise.all` (`deleteParentsWithChildren` in `gdpr/batch.ts`).
- A cache write (`actionCache`) must never fail the caller.

## Sharding and concurrency

- A row lives on the shard of the user who OWNS its object; placement follows the request's shard, not `.shardBy()`.
- In a shard use `lib/shard-context.ts`; scheduler jobs use `runAfterOnShard`. Wrap HTTP actions with `lib/http-shard.ts`; workflows use `onUserShard`; auth hooks `createShardClient(env.SHARD).forShard(userId)`.
- Cross into another user's shard only via `lib/cross-shard.ts#callOnShard` (actions / HTTP only). Webhooks route via `.global()` `shardRoutes`; every writer of those rows must keep its route.
- A new cross-user read: route to the owner, or move the indexed data to `.global()`.
- A new `.global()` table with a user column belongs in `GLOBAL_USER_COLUMNS` (`lib/account-merge.ts`).
- `__root__` holds only root work (cron `cronRuns`, HTTP-level rate limits, anonymous writes).
- **Scheduler lanes**: one SchedulerDO per user shard via `lib/shard-scheduler.ts`; `cancel`/`get` only from the target shard. Keep scheduled work SHORT.
- Long work goes on the jobs queue (`enqueueJob`); config in `lib/job-queue-config.ts`. Every queue target must claim its work in a mutation first and tolerate redelivery; a paid target without its own row uses `{ once }` (`runJobOnce`).
- Crons: one one-minute `tick`. Add periodic jobs to `PERIODIC_JOBS`, never a new `crons.interval`; per-user periodic work goes in `shardSweeps()`. Census writes must never fail the caller.
- `rateLimits` must NOT be `.global()`.
- Never hand `.global({ d1 })` a fresh wrapper per request.
- `ctx.db` by-id calls take the table first (`get(table, id)`, `patch(table, id, …)`); never use `normalizeId` to find a row's table.
- Keep first-paint queries few; load the rest lazily or after first paint (`first-paint.e2e.test.ts`).
- Every outbound `fetch` needs a deadline (`fetchWithDeadline`, `fetchWithTimeout` for user URLs, `signal:`), except the gateway streams.
