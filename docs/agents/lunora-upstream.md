# LUNORA: UPSTREAM ISSUES, ADVISORIES, DUPLICATE COPIES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## Upstream: what is open, and what must not be re-filed

**Every defect from the migration audit is fixed or declined** — that batch is
closed out. One of ours is open: [#687](https://github.com/anolilab/lunora/issues/687)
(cloud spend cap prices 35 meters against one observed; non-blocking).
Fixed upstream, with a choice here still in force: [#1037](https://github.com/anolilab/lunora/issues/1037)
(`lunoraTest` now takes `queues` / `notify`; `notifications/push.test.ts` still splices one
shared facade, since `lunora/notify.ts` makes a fresh memory store per ctx),
[#1053](https://github.com/anolilab/lunora/issues/1053) (`stateScope` exists, but
`lib/upload-route.ts` builds per request anyway), [#796](https://github.com/anolilab/lunora/issues/796)
(reconnect resubscribes are paced, but first-paint seeds are not, so
`MAX_CONCURRENT_SEEDS` stays) and [#822](https://github.com/anolilab/lunora/issues/822)
(`rls()` dropped the SQL LIMIT on the legacy builder; fixed in `@lunora/server@alpha.145`.
The ORM-facade reads and
`agent/admitted-thread-db.ts` stay, as ordinary code, not as a workaround).

Moving queue, mail, push and uploads onto Lunora (2026-10) filed and saw fixed,
workarounds retired with `@lunora/cli@alpha.365`:
[#1036](https://github.com/anolilab/lunora/issues/1036) (a `-preview` queue routed
to no handler — now aliased by the `env.preview` producers in `wrangler.jsonc`;
`Queues` is keyed by name; `maxConcurrency` exists but stays in
`lib/job-queue-config.ts` while `alchemy.run.ts` reads it there).
The same window shipped [#1030](https://github.com/anolilab/lunora/pull/1030):
`api.*` / `internal.*` nest by folder (`internal.lib.job_once.runJobOnce`), and
`internal` is imported from `_generated/internal`.

**A codegen regression can hide behind exit 0.** #810 turned 138 outputs into
`unknown` while codegen exited 0 and no advisory fired; only consumers'
`lint:types` showed it. After a codegen bump, compare
`cat backend/lunora/_generated/{api,internal}.ts | grep -c "unknown>"` with the
previous count. The count moves when procedures are added: it was 36 when the bots export
collector joined (its `v.array(v.any())` is kept on purpose so a new bot column cannot fail the
export), and 40 on main and on codegen 396 (2026-11-03: 10 in `api.ts`, 30 in `internal.ts`). A
rise is a regression only if a procedure that was typed is now `unknown`, so compare the
procedure names, not the number. Run codegen twice
after a change that renames references: inference reads the source, and a
reference codegen cannot resolve yet types its caller's output `unknown`. When probing
generated output, run `tsc` per project: `vis run lint:types` re-runs the
backend's `codegen` target first and silently overwrites any `_generated/`
you are testing. **Build the packages first in a fresh checkout or worktree**
(`pnpm build:packages`): `packages/*/dist` is git-ignored, and without it a
return type imported from `@neore/service-sdk` degrades to `unknown` with codegen still exiting 0.

**Workflows are wrangler `exports`, keyed by class name** (since
`@lunora/workflow@alpha.69` / codegen alpha.240): the runtime finds one as
`env[ClassName] ?? ctx.exports[ClassName]`, so `wrangler.jsonc` declares
`exports.<Class>WorkflowWorkflow = { type: "workflow", name }` (no
`workflows[]`), and the build manifest's workflow `binding` IS the class name,
which is what `alchemy.run.ts` binds. `deploy-bindings.test.ts` pins both.

**The shard registry is its own Durable Object.** `src/server.ts` declares
`.shardRegistry((env) => env.SHARD_REGISTRY)` and exports `ShardRegistryDO`
(from `_generated/shardRegistry.ts`); wrangler.jsonc binds it and creates it
in migration `v2`, and the build manifest carries it, so `alchemy.run.ts`
binds it like `SHARD`. Declaring it does both halves: every shard registers its
key on its first write to a `.shardBy()` table, and the generated worker builds
the `queryCoordinator` over it — fan-outs (`admin/import`/`export`, cross-shard
`rank()`, reverse relations, backups) reach the shards it lists (30s cache).
A shard written before the registry was
bound is listed only after its next write (no data exists yet).

|                                                       |                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| [#687](https://github.com/anolilab/lunora/issues/687) | Cloud prices 35 meters against one observed.                     |
| [#360](https://github.com/anolilab/lunora/issues/360) | Pluggable queue drivers; feature request, closed as not planned. |

Check
`gh issue list --repo anolilab/lunora --author prisis --state open` rather than
trusting this table.

**[#651](https://github.com/anolilab/lunora/issues/651) closed as
works-as-intended, and the behaviour is permanent: `export const x = factory()`
is dropped from `api.ts`.** Following a call expression back to a builder chain
is unbounded, so resolution is out of scope and the DIAGNOSTIC is the fix
(`procedure_not_registered`, shipped in
[#676](https://github.com/anolilab/lunora/pull/676)). Write the builder chain
directly. Do not re-file.

These four were **declined** — constraints, not defects. Do not re-file:

| finding                          | why                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| nested index paths               | denormalise instead; reopen only if the count grows                                                                                                 |
| `databaseHooks` without `ctx.db` | better-auth's own shape, not Lunora's — the consequence is documented in `backend/lunora/auth/hooks.ts`                                             |
| `allowFullScan`                  | unnecessary: an unlimited `findMany` already returns every row (verified — 40 inserted, 40 read back, so `DEFAULT_LIMIT = 25` does not apply to it) |
| flattened API namespaces         | moot: `api.*` / `internal.*` nest by folder since `@lunora/codegen@alpha.275` (lunora#1030); dispatch keys stay flat                                |

**If you ever probe codegen for a dropped export, assert a control.** A
malformed probe produces exit 0 and an unchanged `api.ts` — byte-for-byte the
same signal as a real drop. A `direct` export in the same file must appear; if
it does not, the probe is broken, not codegen. The bare form
`query({ args, handler })` is not a valid probe either — the generated `query`
is a non-callable builder object, so that call is `any` even on a healthy
install. Use a builder chain.

## Reading advisories

The tree draws **0 ERROR, 4 WARN, 64 INFO** (2026-11-04, codegen alpha.399), and every one
left is by design: the `user` counts (better-auth writes that table outside `ctx.db`, so an
aggregate counter would drift), `addTeamMember`'s captcha (an authenticated admin action), the
usage backfill's re-arm (its cursor is the `usageBackfill` row), internal `owner_field` inserts,
tables written by the vector API / better-auth / the payment component, ordered reads the
"redundant" indexes serve (and the schema-drift gate cannot drop an index while
`agent/vector/index.ts` and `lib/rls/scope.ts` pass index names as variables), and secrets and
tokens that must stay `crypto`-random. Advisories never fail codegen; test files
(`*.test.ts`, `__tests__/`, …) are not analysed. **Piping codegen's output truncates that list** at wildly
different points (one run printed 88 and looked like the whole set), so redirect
to a file and count there:

```bash
cd backend && ./node_modules/.bin/lunora codegen > /tmp/cg.log 2>&1
sed -i 's/\x1b\[[0-9;]*m//g' /tmp/cg.log
grep -oP "\[(ERROR|WARN|INFO)\] \K[a-z_]+(?= —)" /tmp/cg.log | sort | uniq -c | sort -rn
```

Conventions that keep new code clear of the advisor:

- **Every public procedure logs one `ctx.log.event`** on each success return, written in the
  procedure itself: one in a helper does not count.
- **Time comes from `ctx.now`**, never `Date.now()`, in a query or mutation.
- **Plain ids come from `ctx.newId()`**; only a token or secret takes `crypto`.

`unbounded_string_arg` (now 26) is purely SYNTACTIC: it flags an
inline `v.string()` in `.input({...})` with no `.max`/`.check`/`.length` chained
on it, and a cap on a shared validator const does NOT count. Write
`v.string().max(MAX_LENGTH.<kind>)` inline (`lib/validators.ts`; the kinds, and
which fields must use `document`, are documented there). The caps bound input;
they were first added to keep the finding count under the TS2590 limit of
[#823](https://github.com/anolilab/lunora/issues/823), which is fixed, so the
count itself no longer matters. There is still no in-tree switch to silence an
advisor rule: `lint: false` drops every finding, the ERROR gate included.

Three rules are worth knowing by name:

- **`procedure_type_check_unavailable`** — the one that matters most. It fires
  when codegen could not read the type of a single registered procedure, meaning
  the registration checks are **not running at all** and their silence proves
  nothing. Codegen resolves the `tsconfig.json` it finds walking up from
  `lunora/`, which need not be the one `tsc --noEmit` uses — so `tsc` passing is
  not evidence codegen could type-check. This tree draws 0; if one appears, fix
  it before trusting any "no findings" conclusion.
- **`procedure_not_registered`** — a factory-assigned export was dropped from
  `api.ts` (see #651 above). WARN, so the build still succeeds without it.
- **`procedure_arguments_unreadable`** — **0 now; keep it there.** Each one means
  a procedure generated `FunctionReference<…, {}, …>`: arguments nothing checks
  at the client boundary. `.input()` resolves an object literal or a `const`
  object literal it names; it does NOT resolve a call (`omit(fields, [...])`) or
  a destructuring rest (`const { userId: _, ...rest } = fields`). **The fix
  pattern is to declare the NARROW (input) set as the literal and spread it into
  the wider doc fields, never the reverse** — `vThreadCreateFields` →
  `vThreadDocFields`, `vProjectCreateFields` → `vProjectDocFields`,
  `streamingMessagesFieldsWithoutState` → `streamingMessagesFields`,
  `userSettingsFieldsWithoutUserId` → `userSettingsFields`. Clearing the last
  four surfaced three real bugs the empty argument type had hidden; the worst was `streamingMessages.stateKind` being written by
  nothing while three index reads depended on it.

## Duplicate `@lunora/*` copies

**All 36 `@lunora/*` packages plus `lunorash` resolve to ONE version each**,
`@lunora/errors` included. That is not the
steady state: the meta-packages (`cli`,
`codegen`, `lunorash`, `studio`, `react`, `agent`, `runtime`, `server`) pin their
siblings _exactly_, so whenever they lag the `alpha` dist-tag by different
amounts pnpm cannot dedupe. Re-count rather than assuming:

```bash
grep -oP "'?@lunora/[a-z-]+@\K[0-9][^(':]*" pnpm-lock.yaml | sort -u
```

**Bump the cluster together, and align to what the meta-packages pin — not to
`latest`.** Check the consuming meta-package's `dependencies` before picking a
version: `@lunora/react@93` depends on exactly `@lunora/client@88`, and taking
the published 89 split the branded `LunoraClient` into two copies, producing four
assignability errors whose two sides print as identical-looking `.d-<hash>` paths.

A duplicate only costs anything when a **nominally-branded** type — a class with
a `private` or `#` member, compared by declaration identity rather than
structurally — from one copy meets the other **inside a single tsc program**.
Both halves matter, and checking is cheap:

```bash
grep -rhoE "^[[:space:]]+(private|#)[A-Za-z_]+" <pkg>/dist/*.d.ts | sort -u
```

Only `client`, `workflow` and `auth` are branded. For everything else extra
copies are structurally interchangeable and an override buys nothing.

**Do NOT add overrides for `client`/`server`/`workflow`/`codegen` and friends.**
Forcing one version overrides the exact pins the meta-packages shipped with, so
`codegen` and `cli` would run against siblings they were never built against —
and since `codegen` emits `_generated/`, that trades a hypothetical type split
for a real risk of wrong generated output. Align the _catalog_ to each
dependency's consuming cluster instead.

Two traps when investigating:

- **Resolution is per-file-location, not per-project.** `apps/web` compiles
  `backend/lunora/_generated/api.ts` as source, and that file's `lunorash/*`
  imports resolve from `backend/node_modules`, which `apps/web` has no path to.
  A probe file dropped in `apps/web/src/` fails with TS2307 and proves nothing.
- **A version present in `node_modules/.pnpm` is not necessarily resolved.** pnpm
  does not prune the store on downgrade. The lockfile is the authority; confirm
  with `find node_modules -maxdepth 5 -type l -lname '*<pkg>@<version>*'`.
