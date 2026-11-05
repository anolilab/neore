# BACKEND (LUNORA PLATFORM) KNOWLEDGE BASE

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## LUNORA (CODE COMPLETE — AWAITING FIRST DEPLOY)

The backend runs on **Lunora** (`anolilab/lunora`). `backend/lunora/**` is the
source of truth. All three trees typecheck clean. There is **no data to
migrate**: no cloud deployment ever existed.

The remaining step is the first deploy, which CI runs.

**Use the Lunora agent skills.** `lunora rules install` put 14 in
`.agents/skills/lunora*`. Start with `lunora`; reach for `lunora-functions` when
writing handlers, `lunora-migration-helper` for any schema change
(widen → migrate → narrow), `lunora-realtime` for subscriptions. They encode
idioms the docs do not spell out.

Upstream issues (open, fixed, and what must not be re-filed), how to read the advisor's findings and
duplicate `@lunora/*` copies are in `docs/agents/lunora-upstream.md`.

## SERVICE BINDINGS

- **Services (service bindings)** — the backend reaches llm-gateway,
  document-parser, browser-renderer and nsfw-checker over Cloudflare service
  bindings declared in `backend/lunora.config.ts` (read STATICALLY by codegen —
  inline string literals only; `dir` is relative to `backend/`). `embeddings`
  is deliberately not declared: nothing calls it, and it still verifies HMAC.
  What is not obvious:
    - **`ctx.services` exists on ACTIONS only** — not queries, mutations or HTTP
      actions (`HttpActionCtx` is fixed upstream). Deep code gets a
      `ServiceFetch` threaded down from the action (`lib/services.ts`:
      `gatewayFetch(ctx)`, `serviceFetch(ctx, key)`) — `getAgent(model, {
gateway })` and `getUtilityModel(gateway, …)` REQUIRE it. An agent built
      in a query/mutation/HTTP action (to read or save messages) passes
      `NO_SERVICE_FETCH`, which throws if a model call ever happens;
      `gatewayFetchFor(ctx)` picks for a ctx of any kind. Never cache a client
      at module level: the binding belongs to the request.
    - **Wrap, never pass `ctx.services.x.fetch` detached.** A `Fetcher` method
      called off its binding throws `Illegal invocation`; Lunora pre-binds it
      only for FETCH services, not RPC-entrypoint ones. `serviceFetch` wraps and
      looks the binding up at call time.
      `isServiceBound` probes inside a `try` (an absent binding is a stand-in
      that throws on first touch) for features that degrade instead of failing.
    - **The gateway is public, so the backend binds its `InternalApi` named
      entrypoint** (`services/llm-gateway/src/index.ts`), not its default
      `fetch` — a binding to the default handler is indistinguishable from an
      internet request, a named entrypoint is reachable only through a binding.
      It runs the same Hono app with an env marked by a module-private `Symbol`
      (`lib/binding-caller.ts`); `internalAuth` admits only that marker, so the
      public handler answers every internal route 404 (no env var can forge
      it). `app.use("/internal/*", internalAuth)` is blanket.
    - **That entrypoint is NOT declared in `lunora.config.ts`.** `entrypoint:`
      there makes it an RPC service typed `ServiceRpc<typeof import("<gateway
src>").InternalApi>` — which drags the gateway's whole source tree into the
      `tsc` of every project compiling `_generated/` (apps/web and the browser
      extension failed with hundreds of `Cannot find name 'KVNamespace'`). The
      gateway is declared as a plain fetch service, and its `services[]` entry
      in `backend/wrangler.jsonc` is HAND-WRITTEN with `"entrypoint":
"InternalApi"` and left out of `package.json#lunora.services`, so Lunora
      leaves it alone (and warns "the hand-written … entry is left as is" on
      every reconcile — expected).
    - **Lunora writes the `services[]` entries** (`SERVICE_<KEY>`, except the
      gateway's — above) into `backend/wrangler.jsonc` and records them in
      `package.json#lunora.services` — on `lunora dev` / `prepare` / `build`,
      NOT on `codegen`. After editing
      `lunora.config.ts`, run `pnpm --filter @neore/backend run prepare:deploy`
      (or start `lunora dev`) and commit both files.
    - **Deploy: Alchemy binds the same names by hand** (`alchemy.run.ts`:
      `SERVICE_DOCUMENT_PARSER: DocumentParser`, `SERVICE_LLM_GATEWAY:
Cloudflare.WorkerEntrypoint(gateway, "InternalApi")`), and the three
      private Workers get `workersDev: false` — Alchemy does not read their
      `wrangler.jsonc` `workers_dev: false`. `deploy-env-bindings.test.ts` pins
      config ↔ wrangler ↔ alchemy and that no `*_URL` / `*_SIGNING_SECRET`
      survives for them.
    - **`@lunora/testing`'s action ctx has no `services`.** A harness suite that
      reaches a service mocks `lib/services` (`voice/speech.test.ts`); pure
      units use a fake `Fetcher` (`chat/lib/gateway-service-binding.test.ts`).
    - **Dev runs TWO gateways.** `lunora dev` runs all four services inside the
      backend's `wrangler dev` session (one `--config` each; no ports of their
      own, each loads its own `.dev.vars`) — that copy is the binding target and
      persists to `backend/.wrangler/state`. The browser's `/v1/*` still needs
      the standalone gateway on :8787 (`pnpm dev` starts it), with its own
      state. Migrate the usage D1 for both (`scripts/dev-setup.js` does).
    - **No `ai` binding at the top level of a service's `wrangler.jsonc`.**
      wrangler treats `ai` as always-remote (`remote: false` is rejected), so one
      in the shared session starts a remote-proxy session that dies without
      `CLOUDFLARE_API_TOKEN` in any non-interactive shell — and takes the
      backend with it; `lunora dev` passes no `--local`. llm-gateway and
      nsfw-checker declare `ai` in `env.production` / `env.preview` only; Alchemy
      binds `AI` itself.
    - **document-parser is a RUST Worker** (workers-rs + xberg;
      document-parser.md). Its `wrangler.jsonc` `build.command` is
      `pnpm --filter document-parser run build:worker`, never `./build.sh` or
      `node scripts/build.mjs`: plain wrangler runs a build command in the
      CALLER's cwd and does not resolve `build.cwd` against the config. `lunora
dev` copes since [anolilab/lunora#934](https://github.com/anolilab/lunora/issues/934)
      was fixed (it runs the build from the service's folder), but CI and the
      deploy start it from the repo root — pnpm runs the script in the package
      dir from anywhere in the workspace. So **starting
      the backend needs the Rust toolchain** (`rustup target add
wasm32-unknown-unknown`, `cargo install worker-build --version 0.8.7
--locked`) unless `services/document-parser/build/` is already there; the
      script skips when `build/` is newer than the sources (a cold release build
      is ~6 min). worker-build downloads wasm-bindgen/wasm-opt/esbuild itself;
      where a firewall blocks that, installed copies in PATH / `~/.cargo/bin`
      are picked up (or `WASM_BINDGEN_BIN` / `WASM_OPT_BIN` / `ESBUILD_BIN`).
      Alchemy uploads `build/` as built (`bundle: false`) and refuses to start
      without it. The 25 MB document cap is one number in three places —
      `src/shape.rs#MAX_DOCUMENT_BYTES`, `lib/document-limits.ts` (backend, and
      the composer through `@neore/backend/document-limits`) —
      `lib/document-limits.test.ts` pins that they agree.

## Codegen

```bash
cd backend && pnpm codegen     # lunora codegen, then backend/scripts/check-generated.mjs
```

- **`_generated/` is not ours to edit.** `check-generated.mjs` patches nothing —
  it is a regression check for a `.pnpm` store-path import codegen once emitted
  (which came back once after an unrelated change). If generated output does not
  compile, the fix goes in a `.d.ts`, in our own source, or upstream.
- **Functions load lazily**, set by `codegen: { lazyFunctions: true }` in
  `backend/lunora.config.ts`, which every entry point reads (codegen, `dev`, `build`,
  `prepare`). The `--lazy-functions` flag still works for one run. The vite and rspack
  plugins no longer take the option. `LUNORA_FUNCTIONS` holds metadata stubs and
  each module under `_generated/fn/` is evaluated on first call, which is what
  keeps the Worker's startup CPU down. Codegen must read every procedure's
  builder chain statically back to a `_generated/server` factory (a `const`
  alias is followed, an `export { … } from` re-export is not — hence the const
  aliases in `lib/crpc.ts`), and `.expose()`/`.x402()` need literal arguments.
  A test that inspects the registry (`rls.guard.test.ts`) must `loadAllFunctions()`
  first, or it sees stubs with no `rls`.
- **One cold pass is reproducible.** `rm -rf lunora/_generated && pnpm codegen`
  reproduces the committed output byte-for-byte.
- **A cold pass breaks a running vite.** While `_generated/` is gone, the app's
  SSR runner caches "Failed to load url …/_generated/api.ts" and answers 500 on
  every route after the files are back — touching them does not help; restart
  vite.
- **`backend` typechecks clean a pass before its consumers do** — it does not
  read its own inferred return types back through `api.ts`, but `apps/web` does.
  Always typecheck **both** trees after a clean codegen; backend-only proves
  nothing.
- **`lunora build` / `lunora prepare` re-run codegen internally**, skipping the
  project's chained step. Use the wrappers
  (`pnpm --filter @neore/backend run build` / `run prepare:deploy`) — they re-run
  `pnpm codegen` and keep the exit status.
- **Codegen runs the advisor as an exit gate**, and a gate that exits 1 does so
  _before_ the chained post-codegen step — so an advisory regression leaves the
  tree half-generated with no clue why. Run the advisor deliberately with
  `pnpm --filter @neore/backend run lunora:advise`; it scores 1,302 procedures and takes
  `--baseline` for regression gating.

## Modules

Every feature folder under `backend/lunora/` (35 of them — everything except
`lib/` and `_generated/`) holds a `module.ts`: `defineModule({ description,
tables })` from `lunorash/server`. Metadata only — no `api.*` path, shard or
runtime behaviour changes, and the root files (`auth.ts`, `crons.ts`, `http.ts`,
`file.ts`, `workflows.ts`, …) and `lib/` stay "outside any module". Modules do
not nest, so `chat/group`, `chat/tags` etc. are all `chat`.

- **`tables` is ownership: the folder whose code defines the table's
  lifecycle.** 131 of 138 tables are owned. Unowned on purpose, because they
  are shared infrastructure every module writes through `lib/`: `actionCache`,
  `cronRuns`, `documentHistory`, `idempotencyClaims`, `rateLimits`,
  `shardActivity`, `shardRoutes`. A new table goes in exactly one module's list
  (codegen rejects a table claimed twice or not in `schema.ts`).
- **A write into another module's table goes through that module's write
  surface**, so the `cross_module_table_write` advisor stays quiet:
  `agent/table-writes.ts` (threads, messages, temporary threads,
  relationships, chat-file grants, vectors), `auth/lib/preference-writes.ts`
  (`aiUserPreferences`, `userSettings`), `browser/session-writes.ts`,
  `vault/lib/file-writes.ts`, `skills/template-skills.ts`. They are PLAIN
  FUNCTIONS over `ctx.db`, not procedures: the write stays in the caller's
  transaction, shard and RLS-guarded `ctx.db`. The docs' fix
  (`ctx.runMutation(internal.<owner>.fn)`) is only for a caller that is an
  action — from a mutation it would be a separate transaction. Their patch
  types list the columns other modules may write; widening one is the owner's
  decision. Patches run through `withoutUndefined` (`undefined` = unchanged).
- **The helpers hide inserts from `owner_field_from_args_not_auth`.** The row
  is built at the call site, so a PUBLIC procedure that passed `args.userId`
  into `insertThread(...)` would not draw the ERROR a direct `ctx.db.insert`
  does. Stamp ownership from `ctx.user` before calling one (every current
  public caller does; the three internal messenger inserts lost their INFO).
- **GDPR draws none.** Each module erases its own tables in `<module>/gdpr.ts`, wired
  into the deletion workflow (`gdpr/steps/*` only orchestrates). The shared helpers in
  `gdpr/batch.ts` take the delete as a callback (`(row) => ctx.db.delete("t", row._id)`)
  so the write names its table in the owner's file: a `TableName` parameter there read
  to the advisor as a write to every table (272 findings until 2026-11-04). Any
  `cross_module_table_write` is a regression.
- **Architecture view**: codegen writes `_generated/architecture.{json,ts}`,
  which are GIT-IGNORED (they changed on nearly every backend PR and caused the
  merge conflicts). `_generated/app.ts` imports `architecture.js`, so anything
  that compiles or runs it needs codegen first: backend `lint:types`, `test` and
  `test:coverage` `dependsOn: codegen` in `backend/project.json`; `lunora build`
  and `lunora dev` run it themselves. A new job running bare `tsc`/`vitest` in
  `backend/` on a fresh checkout must run `pnpm codegen` first (TS2307 else).
  (Studio → Functions → Architecture; admin-gated
  `GET /_lunora/admin/architecture`). ~1,900 edges and ~510 "call sites could not
  be drawn" — mostly by design: refs held in variables
  (the cron job table, `ROUTES`), calls into our plain-function helpers, and the
  three workflows (their handlers live in config objects
  imported into `workflows.ts`, so no workflow → step edge is drawn). There are
  no HTTP-route, queue-send or `invoke` edges: routes are a hono app, jobs are
  sent by function path (`lib/job-queue.ts`; the two `queues.ts` queues appear
  as nodes only), and services are reached through `lib/services.ts`.
  `architecture.ts` is inlined into the Worker (~430 KiB raw, ~37 KiB gzip).

## Validators: `v` vs zod

**zod stays** — 63 files need it for AI SDK tool `inputSchema` and
`generateObject`. What was removed is zod used only to declare a Lunora validator
via `v.from(...)`.

`v` is richer than it looks; check before assuming a gap:

- `.check(pred, { message, schema })` — refinements, enforced at parse time and
  emitted into the JSON Schema. This covers `z.string().min(1)` / `.regex()` /
  `z.number().min().max()`.
- `.parse()` matches zod. **`.safeParse()` does not** — it returns
  `{ ok, value }`, not `{ success, data }`.
- No `enum` — spell out `v.union(v.literal("a"), v.literal("b"))`.
- No `.strict()` — `v.object` STRIPS unknown keys rather than rejecting, and a
  `.check()` cannot restore rejection because the predicate receives the
  already-stripped value.
- **`.output()` is the exception: it REJECTS undeclared keys** ("Response did
  not match the declared output schema … expected only the declared keys"). A
  hand-listed subset of a table's columns as an output validator therefore
  fails at runtime on exactly the rows that carry a column it forgot —
  `checkThreadAccessWithData` failed the share toggle, thread updates and
  follow-ups on every categorised, branched, tagged or group thread. Spread the
  full doc fields (`{ ...vThreadDocFields }`) rather than re-listing them.
- No `.extend()`, no `looseObject` — write the combined shape out.
- `.default(x)` is a COLUMN default, not argument coercion: it does not fill a
  missing value on parse. Use `v.optional(...)` and default in the handler.
- **A bare `v.any()` is an OPTIONAL key** in both `Infer<>` and generated
  `api.ts` (they disagreed until #688; probed on codegen 204). So write
  `v.optional(v.any())` only when the field really is optional. The 68 existing
  uses all mark genuinely optional fields (optional columns, in-flight GDPR
  replays); `vWorkflowNode.data` was also the old workaround.

**Codegen resolves an inline validator expression and `v.from(someConst)`, but
NOT a bare const reference** — that degrades to `unknown`. When a generated type
comes out `unknown` or `{}`, this is usually why. The same trap one level down:
**`v.object(fieldsConst)` degrades to `{}` in `dataModel.ts`, while
`v.object({ ...fieldsConst })` and a const that IS an inline `v.object({...})`
both resolve** — which is why `vSkillConfig` and `connectors/lib/validators.ts`
spell their fields inline or spread them. **A call is unreadable too:**
`.output(docOf("chatFiles"))` typed its result `{}` for every consumer; declare
the projection inline instead.

**Trust a typecheck's EXIT CODE, never a count.** The backend `tsc --noEmit`
can outlast a `timeout`, and `timeout … tsc | grep -c "error TS"` then prints
`0` for a run that was killed before reporting anything — several "clean"
reports were exactly that. Run it to completion (`pnpm lint:types`) and read
`$?`.

**A call in `.input()` registers an EMPTY argument shape.** `v.object(partial(pick(...)))`
or `v.object(someConst)` generated `patch: {  }`, and the runtime silently stripped every key
(thread status stuck on `running`, dropped title and project patches). Harness tests validate
with the SOURCE validators and stay green; `lib/argument-shapes.guard.test.ts` reads
`_generated/{api,internal}.ts` and is the catch. Spell the patch as a literal (`vThreadPatchFields`).

**Declare `.output()` on every procedure.** It is authoritative — a declared
`.output()` shapes the generated type. A procedure without one falls back to
inference, which drags in the rule below.

**Codegen writes the module a type was resolved THROUGH, not the module that
declares it.** So a barrel re-export in OUR source decides what lands in
generated output. Import a type through a directory module and codegen emits
`import("../that/dir.js")` — the `.js` is appended unconditionally, which is
correct for a file and resolves to nothing for a directory, and the tree simply
does not compile. **In a procedure whose return type is inferred, import types
from the module that declares them, not from a barrel.** Declaring `.output()`
avoids the question entirely.

## RUNTIME LESSONS (D1 vs DO)

`tsc` clean is not "works". Every item below typechecked fine and failed on the
first real request. They were found by driving the app in a browser
(`apps/web/e2e/auth-flow.mjs`, `apps/web/e2e/authed-chat.mjs`, against a live
`dev:backend` + `dev:app`).

## Database access

- **`.global()` tables have no legacy reader.** `ctx.db.query(t).withIndex(...)`
  throws at runtime. Global tables must go through the ORM facade:
  `ctx.db.<table>.findFirst({ where })` / `.findMany({ where, orderBy, limit, cursor })`.
  Sharded/root tables still accept the old builder, which is why this hides until
  a D1 table is hit. `backend/lunora/lib/global-table-reader.test.ts` catches it
  and names the call site.
- **`findMany` with no `limit` returns EVERY matching row.** It does not refuse
  an unsized scan and `DEFAULT_LIMIT = 25` does not apply. It always returns a
  `QueryPage`, so `.page` is required even unbounded. **Test a write-then-read
  past 25 rows before trusting any claim about read completeness** — a 12-row
  table cannot tell a complete read from a capped one.
- **`findUnique` exists**, throws `NOT_UNIQUE` on a second match, and takes
  neither `limit` nor `cursor`.
- **An index `.eq()` takes `null`, never `undefined`,** for an unset column.
  `undefined` builds a bound-less placeholder and SQLite rejects the whole
  statement (`near ")": syntax error`). `args.x ?? undefined` is the trap;
  `args.x ?? null` is the fix.
- **`ctx.db.patch` refuses `undefined` as a value** (`Cannot patch field 'x'
to undefined`) although its type accepts it. **`null` is no way out** for a
  `v.optional` column: it writes, then reads back as `null` and fails every
  output validator declaring the column. Removing a field means replacing the
  row — `lib/patch.ts`: `patchRow`/`patchById` (`undefined` = remove) or
  `withoutUndefined` (`undefined` = leave unchanged). `insert` drops
  `undefined` keys, so only patches bite. `lib/patch-undefined.guard.test.ts`
  type-checks every `db.patch` call and fails on one that can pass `undefined`.
- **`.global()` D1 tables are created LAZILY, on first access.** There is no
  migration bookkeeping table and `server.ts` deliberately omits
  `ensureMigrated`, so a table you just added to `schema.ts` is genuinely absent
  from the local sqlite file until something touches it —
  `SELECT sql FROM sqlite_master WHERE name='x'` returning empty proves nothing
  about whether your schema change landed. Exercise the route, then re-read.
  The Worker's own sweep (`auth/lib/ensure-global-tables.ts`, ~350 statements
  even when every table exists, sent in a few D1 batches since `@lunora/sql-store`
  alpha.176: ~3.4 s for a re-sweep on staging, 64 s when they were sequential round
  trips) is skipped once `globalSchemaMarker`
  holds the schema's fingerprint, so a schema change is picked up by the next
  cold isolate; drop that row if you drop a table by hand. The ShardDO's lazy
  sweep inside Lunora still runs once per DO isolate.
- **`lunora build` runs a schema-drift gate**, separate from the advisor. It
  diffs `schema.ts` against the committed baseline
  `backend/lunora/.lunora-schema.json` and exits 1 on a breaking change with no
  migration — so a field rename fails the build long after working fine in dev,
  because dev never consults the baseline. Since `@lunora/cli@alpha.463` the gate
  classifies each change by what it can do to stored data (a dropped index is safe;
  a new unique index, a shorter TTL or a shard-mode flip needs a migration that
  names it) and `--update-schema-baseline` is gone (an unknown option);
  `--allow-schema-drift` skips the gate for one run WITHOUT advancing the
  baseline. Safe changes advance the baseline on `lunora prepare`, so commit
  `.lunora-schema.json` with the change (a package bump can add columns to the
  payment tables). Once there is data at rest, use the widen → migrate → narrow
  path from the `lunora-migration-helper` skill instead.
- **Delete audited rows one at a time.** Every write to a table in
  `lib/audit-triggers.ts#AUDIT_TABLES` fires a trigger, and a `Promise.all` of
  deletes over a batch nests them past the runtime's limit ("trigger recursion
  exceeded 50 levels"). It surfaces only at batch size — a 12-row fixture
  passes. Batched GDPR steps use `deleteParentsWithChildren`
  (`gdpr/steps/deletion-steps.ts`), which is sequential and pinned by a
  full-batch test on `files`.
- **A cache write must never fail the caller.** Two cached queries warming on the
  same first paint both write `actionCache`; one loses the optimistic-concurrency
  check. `ActionCache.fetch` logs and returns the computed value rather than
  propagating a 409.

## Sharding and concurrency

- **Per-user sharding: a row lives on the shard of the user who OWNS the
  object it belongs to** (per-user-sharding.md). `ctx.db` never
  routes by a table's `.shardBy()` field — a row lands in whichever Durable
  Object executed the write — so what decides placement is which shard each
  REQUEST lands on:
    - **Client RPC and live-query sockets** that name no shard go to the
      CALLER's own (`src/shard-routing.ts#withCallerShard`, in the Worker's
      `fetch`, so no client can forget it; the identity it resolves is reused by
      `resolveIdentity` — a socket ticket is single-use). No identity →
      `__root__`. The web client names a shard only for someone else's object:
      a shared thread or page goes to its OWNER's shard through
      `apps/web/src/lib/lunora/shard-routing.ts`, keyed on the call's
      `threadId`/`chatId`/`pageId`/`streamId` arg and filled by
      `resolveThreadShard`/`resolvePageShard` and the invite-accept results. A
      collaborator's rows (prompt messages, page comments) therefore live on
      the owner's shard; `userId` still names the author.
    - **Code running IN a shard** knows it through `lib/shard-context.ts`: the
      `ShardDO` subclass in `src/server.ts` runs every entry point in an
      `AsyncLocalStorage` holding `ctx.id.name`. `ctx.scheduler` jobs (via the
      wrapped SCHEDULER namespace, `lib/shard-scheduler.ts`) and `enqueueJob`
      default their `shardKey` to it; an explicit `shardKey` wins. The
      scheduler's 4th arg is untyped upstream — use `runAfterOnShard`.
    - **HTTP actions** run in the Worker, not a shard: wrap them
      (`lib/http-shard.ts` — `onCallerShard`, `inShard`, `onRoutedShard`) so
      their runners, scheduler and queue target the right shard. `/chat/start`
      and `/chat/chunks` resolve a thread's owner (`lib/thread-shard.ts`);
      webhooks look the owner up in `.global()` `shardRoutes`
      (`messenger:<id>`, `trigger:<id>`, `thread-public:<token>`,
      `page-public:<token>` — every writer of those rows keeps its route).
    - **Workflows** bind `context.run` to the user's shard
      (`lib/workflow-shard.ts#onUserShard`); **auth hooks** call
      `createShardClient(env.SHARD).forShard(userId)`.
    - **Crossing into another user's shard from server code** is
      `lib/cross-shard.ts#callOnShard` (actions / HTTP only): anonymous public
      views (`getPublicThread`/`getPublicPage`/`getPublicWorkflow` are ACTIONS
      for this reason), gallery forks, admin cleanup.
- **What is `.global()` because it is read across users:** grants and invites
  (`threadAccess`/`threadInvites` carry `ownerId`; `pageAccess` also carries the
  page's `title`/`icon` and the grantee's `favoritedAt`, so a grantee's sidebar
  never reads the owner's shard), org-shared `projects`/`prompts`/
  `promptHistory`/`userVariableDefaults`, the content-addressed
  `chatFiles`/`chatFileAccess` (identical bytes from two users share ONE R2
  object; a per-shard refcount would reap it under the other), and the routing
  tables `shardRoutes`/`shardActivity`. A new cross-user read means one of:
  route the request to the owner, or move the indexed data to `.global()`.
- **A guest who signs up keeps their data**: conversion creates a NEW user, so
  `anonymous({ onLinkAccount })` (`auth.ts`) queues a job that moves every shard-local row from
  the guest's shard to the new user's under the same ids
  (`lib/account-merge.ts`) and re-points `.global()` rows. A new `.global()`
  table with a user column belongs in its `GLOBAL_USER_COLUMNS`.
- **`__root__` now holds only root work**: the cron tick's `cronRuns`, HTTP-level
  rate limits (per IP / admin seed), and anything an anonymous caller writes.
- **Scheduler lanes: one SchedulerDO per user shard.** Upstream builds
  `createScheduler({ namespace })` with no `instanceName` and never defaults a
  job's `shardKey` — so without `lib/shard-scheduler.ts` a job scheduled on a
  user's shard runs on `__root__` and finds none of their rows. That stamping
  is the load-bearing half. The other half sends each `/schedule` to its TARGET
  shard's own instance (`shard:<userId>`); root jobs keep `default`. Since
  `@lunora/scheduler@alpha.79` one instance drains up to six jobs at once
  (#793), so this is now isolation — each user gets their own six lanes and
  15-minute alarm budget — rather than the only concurrency there is.
  `cancel`/`get` find a job only from the shard it targets. Keep scheduled
  work SHORT; the upstream patch that retires the wrapper is in the plan.
- **So long work runs on the jobs queue** (`@lunora/queue`: `jobs` and its
  DLQ `jobsDeadLetters` in `lunora/queues.ts`, consumed by the generated
  `queue()` handler; `lib/job-queue.ts:enqueueJob` sends to the `QUEUE_JOBS`
  producer, which is `ctx.queues.jobs` built off the env so HTTP actions, auth
  hooks and tests can send too). Names, `maxRetries`, `retryDelay` and the DLQ
  are the `defineQueue` literals; batch size, batch wait and concurrency live
  in `lib/job-queue-config.ts`, because `lunora dev` rewrites every declared
  field into wrangler.jsonc. wrangler.jsonc and alchemy.run.ts follow both. A
  preview deploy suffixes queue names `-preview`; `src/server.ts` strips it
  before the generated consumer routes the batch by declared name. A dispatch
  that fails deterministically (400/403/404/422) is acked and logged by
  `@lunora/queue`, not retried into the DLQ. On the queue: `runStreamingAgent`
  (incl. group turns), `continueAfterToolApproval`, `runTaskRound`, `finishCodingAgentRound`,
  `runEvalCase`, `/chat/media`'s image/audio/video generation, and the
  coding-agent start and polls. On the scheduler: title,
  category, memory extraction, reapers, crons and other short or timed jobs.
  `/chat/start` enqueues the agent BEFORE scheduling its title jobs.
  **Every queue target must tolerate redelivery** (at-least-once): claim the
  work in a mutation before doing any, and return quietly when the claim is
  taken — stream `runClaimedAt`, task `claimRound`, eval `claimCase`,
  coding-agent `claimRun` / `claimPoll`. A target with no row of its own to
  claim on (media generation — a paid call must never run twice) is enqueued
  with `enqueueJob(ref, args, { once })`, which wraps it in
  `lib/job-once.ts:runJobOnce`: a claim-once taken before the target runs,
  with a deadline cleared when it returns or throws. A delivery that dies
  mid-run is NEVER re-run (it may already have paid); when its deadline lapses
  the cron tick (`reapLapsedClaims`) runs its `onLapse` — for media,
  `chat/media-abandon.ts` fails the pending row stamped with that `jobId`
  (`providerMetadata.neoreJob`), so the user can retry. A redelivered
  `runStreamingAgent` is dropped (the claim is taken), but a run whose worker DIED is
  resumed by the interrupted-run watchdog (see "Edge streaming" in `backend/lunora/chat/AGENTS.md`): from its last SAVED
  row, so a step that finished is never run again. The step in flight was lost; its
  model call may have been billed (the gateway records usage per call) and the re-run
  is a new call charged on its own, so the guarantee is "no completed step charged
  twice", not "one model call". A run that died inside a TOOL is never resumed.
  **Local dev:** Miniflare's broker ignores `max_concurrency` and runs one
  batch at a time, so wrangler.jsonc batches 10 per second
  (`JOBS_QUEUE_DEV_CONSUMER_OVERRIDES`) — a batch's messages dispatch
  concurrently — while the deploy uses batches of one, delivered at once, with
  `maxConcurrency` invocations. Dispatch needs `LUNORA_ADMIN_TOKEN`, which the
  deploy now requires.
- **Crons: ONE trigger, a one-minute tick.** Cloudflare allows at most 3 Cron
  Triggers per Worker; `crons.ts` registers only `tick` (`* * * * *` →
  `cronTick`), which runs the one-minute jobs every time and each periodic job
  when its slot is due (`lib/cron-schedule.ts`: epoch-aligned intervals, daily
  UTC times — the cadences of the expressions it replaced). A slot is claimed
  in `cronRuns` before the job runs, so a duplicate tick runs nothing twice and
  a failed job waits for its next slot. **Add a periodic job to
  `PERIODIC_JOBS`, not a new `crons.interval(...)`** — a second expression is
  another trigger. The Worker entry must forward `scheduled` to the app; it did
  not, so no cron ever ran deployed (`src/server.scheduled.test.ts`).
  Locally, fire it with `curl "localhost:8788/cdn-cgi/local/scheduled?cron=*/1+*+*+*+*"`.
  **The tick runs on `__root__`, so it FANS OUT per-user work**
  (`lib/shard-housekeeping.ts`): the `.global()` `shardActivity` census says
  which user shards exist. `dispatchDueShards` (every minute) sends
  `runShardTick` to shards whose `nextDueAt` has passed — schedule triggers and
  recurring tasks arm it with `noteShardDue` — and `dispatchShardHousekeeping`
  (every 10 min) sends `runShardHousekeeping`, the per-user cleanup sweeps, to
  shards active since their last sweep (and daily to any active within 30
  days). A new per-user periodic job goes in `shardSweeps()` there, not in
  `EVERY_MINUTE_JOBS`, which only sweeps root. Census writes are best-effort
  hints and must never fail the caller.
- **`rateLimits` is deliberately NOT `.global()`** — `@lunora/ratelimit`'s
  `createDbStore` reads through the legacy builder, and its read-then-write pair
  is only atomic under a DO input gate, which D1 does not provide. Putting
  `.global()` back breaks every rate-limited mutation.
- **The FIRST `.global()` D1 access in an ISOLATE costs ~3s; a warm ORM read
  ~30ms.** The 3s is Lunora creating the global tables lazily (368 statements,
  99 of them `sqlite_master` reads, measured 2026-09-25), and it re-runs after
  EVERY hot reload or restart — which is why "the first request is slow" in
  dev. (Locally the round trips are cheap; from a deployed Worker to D1 the same
  sequential sweep was a minute, hence the batching above.) It is keyed on the D1 binding object: anything that hands `.global({ d1 })`
  a fresh wrapper per request re-runs it on every request (a timing proxy once
  did, costing ~3s per read). The old note here ("~1s per request, miniflare's
  loopback") was a misreading of this.
- **`ctx.db` by-id calls take the TABLE first** (`@lunora/server` alpha.240+):
  `get(table, id)`, `patch(table, id, values)`, `replace`, `delete`, `restore`,
  `deleteMany(table, ids)`, `patchMany(table, patches)`. The bare-id forms probed
  EVERY table (one batched D1 round trip across 41 global tables, ~70-125ms
  locally each), which is why they are gone; an unknown table throws
  `BAD_REQUEST`. The facades (`ctx.db.<table>.get(id)`) are unchanged. The id
  itself carries no table — `db.normalizeId(table, id)` only checks its SHAPE and
  returns the id for any table, so never use it to discover a row's table. The
  `embeddings_*` tables are the one place the table is unknown at the call site:
  `agent/vector/tables.ts#findVectorTable` reads each dimension's table in turn.
  `lib/patch.ts`: `patchRow(db, table, row, changes)` / `patchById(db, table, id, changes)`.
  A test callback typed `ctx: any` is NOT checked by `tsc`, so a stale one-argument
  call fails at runtime ("<uuid> is not a table in this schema"); `lib/global-get.guard.test.ts`
  still fails on a new un-hinted global read.
- Multiply a slow first access by the one-at-a-time shard and N concurrent
  first-paint queries cost N × that of wall clock (measured before per-user
  sharding, on `__root__`): 5 concurrent = 4.9s, 10 = 8.8s and the backend dies. **Count your
  first-paint queries** — `/chat` fires four: `getThreadListData`,
  `getUserSettings`, `listProjects`, `getAIUserPreferences` (live queries
  count their WebSocket `subscribe`, not just HTTP RPC). Features had pushed
  it to fifteen; the rest now load when their UI opens (`skipToken` until the
  popover / "/" / "@" / menu opens) or after first paint
  (`hooks/use-after-first-paint.ts`: changelog, usage ring, admin link,
  impersonation banner). `apps/web/e2e/first-paint.e2e.test.ts` fails above
  its budget — fold new first-paint data into a composite instead of raising
  it.
- **An unbounded outbound `fetch` in a `__root__` procedure is a self-inflicted
  denial of service**, because it holds the shard for its whole duration.
  `getChangelogs` did exactly this until it got `AbortSignal.timeout(5000)` plus
  a module-level cooldown. **Every outbound call under `backend/lunora` now has
  a deadline**: `lib/fetch-timeout.ts#fetchWithDeadline` for hosts we chose,
  `chat/tools/utilities.ts#fetchWithTimeout` for user-influenced URLs (SSRF
  guard), `signal:` on generated service-SDK calls. The two exceptions are the
  gateway STREAMS, deliberately — a whole-request timeout truncates a long
  generation. A new `fetch(` without one of these is a regression.
