# Per-user sharding

Status: implemented (2026-09-23). There is no deployed data, so this plan has no
row migration. The schema-drift baseline is advanced deliberately.

## The problem

Every table is `.shardBy("userId")`, root-scoped or `.global()`, but
`.shardBy()` routes nothing by itself. `ctx.db` in `@lunora/shard-engine` does
not route by the shard field: a row lives in whichever Durable Object executed
the write. A request lands on the shard its envelope names (`shardKey`, else
`__root__`). Nothing in this app names one, so every procedure, live query,
scheduled job, queue job, cron and workflow step runs on the one `__root__`
DO, one at a time.

What that costs, measured before this change on the shared dev stack (guest
`/chat`, see "Measurements"):

- A single first paint reaches the composer in ~3.8s.
- Four concurrent first paints each take ~19-20s, because every call queues
  on `__root__`.

## The rule

**A row lives on the shard of the user who owns the object it belongs to.**
For private data that is the caller. For thread- and page-scoped rows, it is
the thread or page OWNER, even when a collaborator wrote the row. For example:

- a grantee's prompt message in a shared thread lives on the owner's shard;
- a collaborator's page comment lives on the page owner's shard.

The `userId` column still names the author. The shard is the owner.

Because `ctx.db` never crosses shards, there are only two ways to make data
readable across users:

1. **Route the request to the owner's shard.** The caller must be allowed
   there (`authorizeShard`), and the procedure's own access check still
   decides what it may read.
2. **Move the data to `.global()` (D1).** This is for data that is inherently
   indexed across owners: grants, invite tokens, org-shared rows, gallery
   listings, and lookups from a public key to an owner.

## Tables

### Stay `.shardBy("userId")`: data lives on the owner's shard

These are all the current sharded tables except the ones moving to `.global()`
below: threads, messages, streams, memories, tasks, evals, pages, files,
knowledge, embeddings, settings, and so on.

Vectorize follows automatically. The generated shard namespaces vectors by the
shard key (`createContextVectors({ namespace })`), so each user gets a
namespace once their requests land on their shard.

### Root-tier tables: no tier modifier, so they follow the request

The 17 tables with no tier modifier are not "root data". They are simply local
to whichever DO serves the call.

These follow the thread or user onto the owner's shard:

- `persistentChunks`, `streamDeltas`, `followupSuggestions`
- `threadKnowledge`, `projectKnowledge`
- `presentationSlides`, `nodeExecutions`, `triggerExecutions`
- `sandboxActions`, `browserActions`, `playgroundApiKeys`
- `idempotencyClaims`, and the per-user `rateLimits` rows

These stay effectively on `__root__`, because only root-routed code touches
them:

- `cronRuns`, the cron slot claims;
- HTTP-level rate limits (per IP, per API key, per trigger, admin seed).

### Move to `.global()` (D1)

| table                         | why                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threadAccess` (+ `ownerId`)  | A grant is read by the owner (by thread), by the grantee (by user) and by `authorizeShard`, and those three sit on different shards.                                                                                                                                                                                            |
| `threadInvites` (+ `ownerId`) | The invitee redeems by token from their own shard, and the token must lead to the owner.                                                                                                                                                                                                                                        |
| `pageAccess`                  | Same as `threadAccess`. It already carries `ownerId`. It also gains denormalised `title`/`icon`, so the grantee's sidebar can list shared pages without reading the owner's shard.                                                                                                                                              |
| `pageInvites`                 | Token redeem, as above.                                                                                                                                                                                                                                                                                                         |
| `projects`                    | Org members list each other's projects (`by_organization`), and the public gallery lists every user's (`by_public*`).                                                                                                                                                                                                           |
| `prompts`, `promptHistory`    | Org sharing: members read and edit each other's prompts.                                                                                                                                                                                                                                                                        |
| `userVariableDefaults`        | Org defaults, written by any admin.                                                                                                                                                                                                                                                                                             |
| `chatFiles`, `chatFileAccess` | Content-addressed (`agent-files/<sha256>`): identical bytes from two users share ONE R2 object, so the refcount must see every user's references — per-shard copies would each reap the object the other still uses. Global also lets a collaborator's upload attach on the owner's shard, and a fork grant the author's media. |
| `shardRoutes` (new)           | Maps a key known before the owner is, to the owner's shard. Keys: `thread-public:<token>`, `page-public:<token>`, `messenger:<connectionId>`, `trigger:<triggerId>`. Kept up to date by the writers of those rows.                                                                                                              |
| `shardActivity` (new)         | Census of user shards with recent activity, used by the housekeeping fan-out (see "Crons").                                                                                                                                                                                                                                     |

Consequences for the tables moving to `.global()`:

- Their readers move from `ctx.db.query(t).withIndex` to the ORM facade.
  `lib/global-table-reader.test.ts` enforces this.
- Row-level security on these tables is whatever `lib/rls` enforces through
  the cRPC builders; the procedure checks remain the primary control. Two
  narrow writes go past it on purpose (`pages/functions.ts`): a grantee
  starring a page patches only `favoritedAt` on their own grant, and a rename
  copies the title and icon onto the page's grants.
- A mutation that writes a sharded row and a global row is not atomic. Every
  such pair here is either a hint (routes, activity) or re-validated on read
  (a grant is checked where it is used).

## How each caller picks a shard

| caller                                                                   | shard                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser, extension, SSR RPC (`/_lunora/rpc`, `rpc-batch`, `/_lunora/ws`) | **The caller's own user id**, applied by the worker (`src/server.ts`) when the envelope names no shard. It resolves the identity once (memoised for the runtime's own `resolveIdentity`) and rewrites the envelope's `shardKey`, or the socket's `?shard=`. A request with no identity stays on `__root__`. Doing this server-side means no client can forget it.                                                                |
| Shared thread or page (a grantee)                                        | **The owner's id, named explicitly by the web client.** `lib/lunora/shard-routing.ts` keeps `threadId`/`pageId` → owner. The accept-invite result fills it, and so does `resolveThreadShard`/`resolvePageShard` on route load, a global read of the caller's grant. `crpc` and live queries attach `{ shardKey }` for any call whose args name a registered object, so a shared thread gets its own socket to the owner's shard. |
| Public share views (thread, page, workflow)                              | **The worker, never the client.** An HTTP route looks the token up in `shardRoutes` (or in `projects`, which is global), then calls an internal query with `ctx.forShard(owner)`. Anonymous callers therefore never need to be allowed into anyone's shard.                                                                                                                                                                      |
| `ctx.scheduler` inside a shard                                           | **The calling shard**, by default. `ShardDO` is subclassed in `src/server.ts` to run every entry point inside an `AsyncLocalStorage` holding its shard key (`lib/shard-context.ts`). The scheduler namespace passed to `.scheduler(...)` is wrapped (`lib/shard-scheduler.ts`) to stamp that key onto each `/schedule` as `shardKey` when the caller named none. An explicit `shardKey` wins.                                    |
| `ctx.scheduler` in an HTTP action                                        | Explicit: `{ shardKey: owner }`. It has no ALS context, so no default applies.                                                                                                                                                                                                                                                                                                                                                   |
| `enqueueJob`                                                             | `options.shardKey ?? currentShard()`. The consumer already forwards `QueueJob.shardKey` through `/_lunora/scheduler/dispatch`.                                                                                                                                                                                                                                                                                                   |
| Workflows                                                                | Every `context.run` passes `{ shardKey: params.userId }` through `workflowRun(context, userId)`. `RunFunctionOptions.shardKey` is typed since `@lunora/workflow@alpha.58`.                                                                                                                                                                                          |
| Crons                                                                    | The one-minute tick stays on `__root__` and runs only root work. Per-user periodic sweeps fan out: the tick dispatches `runAfter(0, sweep, {}, { shardKey })` for each shard that `shardActivity` says is due. Timed per-user work (due triggers, recurring tasks) is armed on the user's own scheduler instance with `runAt(nextDue)`.                                                                                          |
| Auth hooks                                                               | `createShardClient(env.SHARD).forShard(userId)`. They are pinned to `__root__` today; that pin is removed.                                                                                                                                                                                                                                                                                                                       |
| `/chat/start`, `/chat/edit`, `/chat/media`, optimizer and workflow HTTP  | `ctx.forShard(shardFor(user, threadId))`: the thread owner if the caller holds a grant, else the caller. Jobs enqueued from there carry that `shardKey`.                                                                                                                                                                                                                                                                         |
| `/chat/chunks` (gateway poll)                                            | The gateway already holds the verified stream token (`userId`, `threadId`). It adds both to its HMAC-signed poll body, and the backend resolves the shard the same way.                                                                                                                                                                                                                                                          |
| Messenger and trigger webhooks                                           | Look the owner up in `shardRoutes` (`messenger:<id>`, `trigger:<id>`), then use `forShard(owner)`.                                                                                                                                                                                                                                                                                                                               |
| Public v1 API                                                            | `forShard(identity.userId)`, the key owner. Thread routes resolve through a grant as above.                                                                                                                                                                                                                                                                                                                                      |
| `/gateway/usage-report`                                                  | `forShard(report.userId)`.                                                                                                                                                                                                                                                                                                                                                                                                       |

## `authorizeShard`

It still compares. It allows a call when:

- `shardKey === "__root__"`, or
- `shardKey === identity.userId`, or
- the caller holds an unexpired grant from that owner: a global `threadAccess`
  or `pageAccess` row with `userId = caller` and `ownerId = shardKey`.

The grant lookup is raw D1, cached per isolate for 30s, negative results
included. A revoked grant can therefore still pass the shard gate for up to
30s, but the procedure's own check reads the global row fresh and refuses. The
shard gate is coarse ("may this caller be on this shard at all"); procedures
remain the fine gate. That is strictly tighter than before, when every caller
reached every row through `__root__`.

## Cross-user access, by feature

- **Shared threads.** Grants and invites are global. The grantee is routed to
  the owner's shard for everything thread-scoped. That covers reads, live
  queries and `/chat/start`, so the run executes on the owner's shard and its
  stream, chunks and messages live there. Memory extraction and retrieval for a
  grantee's turn in someone else's thread is skipped: the grantee's memories
  live on the grantee's shard.
- **Public thread/page/workflow.** Served by worker routes through
  `shardRoutes` and `forShard(owner)`, so no anonymous shard access is needed.
- **Pages collaboration.** Grants and invites are global. Every page-scoped
  call routes to the owner. Comments, versions and presence written by
  collaborators live on the owner's shard. The grantee's sidebar lists shared
  pages from the denormalised title on the grant. Search over shared pages
  matches titles only; content search is own pages only.
- **Org-shared prompts, projects and variables.** They are global.
- **Skills.** Already global.
- **Gallery.** `projects` is global. Forking copies the author's vault rows
  through `createShardClient(env.SHARD).forShard(author)` from an action.
- **Admin.** User and session admin is global already. Anonymous-user cleanup
  calls each user's shard with `forShard(userId)`.
- **GDPR.** The workflows run every step on the user's shard, and the global
  grant, invite and prompt rows are deleted from the global tables.

## Guest → account conversion

better-auth converts an anonymous user by creating a NEW user and linking the
guest afterwards. There was no link hook at all before this change, so a
guest's history never followed them, even on `__root__`. Now
`anonymous({ onLinkAccount })` (`auth.ts`) queues `lib/account-merge.ts#runGuestMerge` on the jobs queue, targeting the new user's shard. It is kept off the sign-up request because the move takes a round trip per table and page. The job:

1. Every non-`.global()` table is read page by page on the GUEST's shard and
   inserted on the new user's shard under the SAME ids, so references between
   rows survive, with the guest id rewritten to the new one.
2. Only then is the guest's shard emptied.
3. `.global()` rows naming the guest are re-pointed.

The new account keeps its own seeded settings. A failure is logged and never
fails the sign-up. A rerun is safe, because ids already copied are skipped.

## Cross-user readers, and where each one reads

| reader                                               | reads                                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| shared threads, pages (sharing, collaborators)       | owner's shard, routed; grants/invites `.global()`                                                              |
| public thread / page / workflow views                | actions crossing to the owner's shard via `callOnShard`                                                        |
| skills marketplace, ratings, stats, org skills       | `.global()` already (`skills`, `skillRatings`, `skillStats`); a caller's installs (`userSkills`) are their own |
| workflow gallery browse / featured                   | `projects` `.global()`                                                                                         |
| gallery fork                                         | author's vault rows via `callOnShard`, copy written on the forker's shard                                      |
| org prompts, projects, variable defaults             | `.global()`                                                                                                    |
| evals                                                | the owner's own data only (no cross-user reader)                                                               |
| admin: user lists, impersonation, audit log, billing | `.global()` (`user`, `session`, `auditLog`, `memberCredits`, …)                                                |
| admin: anonymous-user cleanup                        | each user's shard via `callOnShard`                                                                            |
| messenger webhooks / pairing, trigger webhooks       | owner found in `shardRoutes`, then `forShard(owner)`                                                           |
| public v1 API                                        | the key owner's shard (`inShard`)                                                                              |
| changelog                                            | `changelogCache` `.global()`                                                                                   |
| cron sweeps                                          | fanned out per shard (`lib/shard-housekeeping.ts`)                                                             |

No reader of user data is left reading `__root__` alone.

## Live queries on more than one shard

A socket is bound to one shard. `LunoraClient` already keeps ONE socket per
`shardKey` (`connections`, keyed `shardKey ?? ""`). Each socket authenticates
with its own ticket through the same `wsToken` provider, which mints a fresh
single-use ticket on every connect. So a user on a shared thread has their
own socket, with the sidebar on it, plus one socket to the owner's shard,
opened the first time a subscription names that shard.

What is not built is idle-closing: an owner socket stays open for the page
session once opened, because the client exposes no per-shard close. There is
one such socket per distinct owner visited, which is small in practice. A
real bound needs a client API (`closeConnection(shardKey)`); this is part of
the upstream proposal below.

## Scheduler serialization (anolilab/lunora#793)

**Status after the bump to `@lunora/scheduler@1.0.0-alpha.79`:** #793 shipped
point 3 below — `SchedulerDO` now drains with up to six dispatches in flight
(the platform's six-waiting-connections limit). Points 1 and 2 did NOT ship:
the generated app still builds `createScheduler({ namespace })`, and
`runAfter`/`runAt` still leave `shardKey` unset. So the wrapper stays. Its
`shardKey` stamping is required for correctness; its per-user instance is now
isolation (six lanes and one 15-minute alarm budget per user rather than per
app) and could be dropped if that isolation is not wanted. Point 5 shipped in
`@lunora/workflow@alpha.58`, and `lib/workflow-shard.ts` lost its cast.

**Upstream behaviour at the time of the design** (`@lunora/scheduler@1.0.0-alpha.76`,
`@lunora/runtime@1.0.0-alpha.130`):

- The generated `_generated/app.ts` builds `createScheduler({ namespace })`
  with no `instanceName`, so every job goes to `idFromName("default")`.
- `SchedulerDO.alarm()` drains due jobs with `for … await drainRecordGuarded`.
- `dispatch` awaits the origin's `/_lunora/scheduler/dispatch`, which answers
  only after the job finishes.

The result is one app-wide lane.

**App-side fix (done here).**

- `createScheduler` already honours `instanceName`, but the generated builder
  exposes no way to set it.
- The one seam is the namespace: `.scheduler({ namespace: (env) => … })`
  receives the binding, and nothing stops us wrapping it.
  `lib/shard-scheduler.ts` maps `idFromName("default")` to
  `idFromName("shard:<current shard>")`, using the ALS shard context, and
  stamps the default `shardKey`.
- Each user shard therefore gets its own `SchedulerDO` and its own lane. Jobs
  for one user still serialize, as they would on their shard anyway. Different
  users no longer wait on each other.
- Root-originated jobs (the cron tick, HTTP actions) stay on `default`.
- `cancel`/`get` from the same shard reach the same instance. The studio's
  scheduled-jobs view only lists `default` (a known gap).

**Proposed upstream patch** (not applied; for anolilab/lunora):

1. `@lunora/codegen` `emit-app.ts`: let `SchedulerDeclaration` take
   `instanceName?: (context: { shardKey: string }) => string`.
    - `createShardDO` should call `config.scheduler(env, { shardKey: this.currentShardKey() })`.
    - `resolveScheduler(env, shard)` should pass
      `createScheduler({ namespace, instanceName: declaration.instanceName?.(shard) })`.
2. `@lunora/scheduler` `createScheduler`: add `defaultShardKey?: string`,
   applied to `runAfter`/`runAt` when `options.shardKey` is unset. The shard
   builds its scheduler with its own key, so a job defaults to landing where it
   was scheduled. Today it silently lands on `__root__`, which is wrong for any
   `.shardBy()` app.
3. `@lunora/scheduler` `SchedulerDO.alarm()`: dispatch due jobs with bounded
   concurrency (`Promise.allSettled` over batches of `maxParallel`, default 8)
   instead of one awaited `for` loop. `drainRecordGuarded` is already
   per-record idempotent, and pools already gate their own concurrency.
4. `@lunora/client`: `closeConnection(shardKey)`, or an idle timeout per shard
   socket once its last subscription goes, so an app can bound the sockets it
   opens to other users' shards.
5. `@lunora/workflow`: add `shardKey` to `RunFunctionOptions`. The alpha.57
   runtime already sends it, but it is untyped.

## Measurements

The dev stack was shared with other agents throughout, so every number is
noisy. The runs were: guest `/chat` in the installed Chrome, with backend HTTP
and WebSocket subscribe→first-data timings. "Composer" is when the composer
became visible. Every run is a fresh guest, so after the change each run also
creates a brand-new user shard (the DO's first migration).

| run                  | before                                       | after                                       |
| -------------------- | -------------------------------------------- | ------------------------------------------- |
| one at a time, warm  | composer 3.75–3.88s, settled ~7.9s           | composer 3.66–3.69s, settled ~7.9s          |
| RPCs / subscriptions | 3 RPC (0.45–0.98s), 5 subs (0.44–0.79s)      | 3 RPC (0.7–1.3s), 5 subs (0.54–1.15s)       |
| four at once         | composer 18.7–20.5s; 1 of 4 opened no socket | composer 9.1–9.5s (second sample 9.5–13.1s) |

- **One at a time**, a first paint is unchanged. Each call is somewhat slower
  because the guest's shard is created cold.
- **Four at once**, first paint is about twice as fast: the four users no
  longer queue on one DO.
- **Failed context.** In every four-way run, before and after, one context
  failed on better-auth's per-IP rate limit for `/api/auth/sign-in/anonymous`
  (429). That is a harness artifact, not the shards.

### e2e failures after the change: A/B on one stack (2026-09-25)

The four multi-turn specs (group chat, regenerate 2/2, public share, guest
conversion) went red after sharding landed. To separate the routing from the
stack, `SHARD_ROUTING=off` (`lib/shard-namespace.ts`, dev-only) pins every
shard key to `__root__` on the same code and the same stack, and
`SHARD_TIMING=on` (`src/development-timing.ts`) logs Worker, DO, D1 and
outbound-fetch timings.

| | routing OFF | routing ON |
| --- | --- | --- |
| requests lost "Network connection lost", firewall NOT approved | 11.8% (41/348) | 12.4% (116/935) |
| of which: rpc / usage-report / dispatch | 14% / 14% / 21% | 15% / 28% / 11% |
| backend → gateway `/internal/model/proxy`, p50 / p90 | 14.4s / 37s | — |
| self-dispatch `/_lunora/scheduler/dispatch`, p50 | 20s | — |
| requests lost, firewall approved | — | 1.2% (2/160) |
| self-dispatch p50, firewall approved | — | 0.7s |

- **Routing off failed exactly like routing on**, so sharding was not the cause.
- **The cause was the host firewall.** OpenSnitch had no allow rule for the
  `workerd` binary this stack runs (1.20260921.1) and had repeatedly added
  temporary DENY rules for it. The gateway's own log shows it answered the
  "14s" proxy calls in 13ms, while every workerd process sat idle (backend 38s
  of CPU in 44 minutes). The seconds were spent getting the loopback connection
  through. Approving the binary cut the loss from 12% to 1.2% and the
  self-dispatch p50 from 20s to 0.7s.
- The remaining failures in these runs came from other agents' hot reloads
  (the worker reloaded every 20–40s), so the A/B was stopped there. The
  decisive e2e run happens on a quiet stack.
- **D1 cost, measured with `SHARD_TIMING=off`:** Lunora's lazy global-table
  setup costs ~2.9s and 368 statements once per isolate (re-run after every
  reload). A warm ORM read is one round trip (~30ms). A new user's shard adds
  no setup. An un-hinted `ctx.db.get(id)` of a global row probes all 41 global
  tables in one batch (~70–125ms locally). A timing proxy that handed Lunora a
  fresh D1 object per request re-ran the setup on EVERY request (~3s a read),
  and the first A/B run was discarded for it.

## Known gaps

- A stranger opening `/chat/<id>` of a PUBLIC thread they hold no grant for no
  longer gets redirected to its share page: the call lands on their own shard,
  where the thread is not. The `/thread/<token>` link itself works.
- A collaborator's turn in a shared thread reads and writes THEIR memories
  on their own shard (`callOnShard` for retrieval, `runAfterOnShard` for
  extraction). The "memories used" popover is not recorded for that turn,
  because it reads the owner's shard.
- The studio's scheduled-jobs view lists only the `default` SchedulerDO
  instance, not the per-user lanes.
- In unit tests the harness is one database for every shard
  (`backend/test/setup-harness.ts`), so a cross-shard mistake does not fail a
  unit test; the e2e suite exercises routing.
- `.shardBy("userId")` is now informational for rows a collaborator wrote on
  an owner's shard. `lunora import` would route those rows by `userId`, to the
  author. The fix is a `ownerId` shard column; out of scope while there is no
  data.
