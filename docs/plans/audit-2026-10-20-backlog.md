# Audit 2026-10-20 backlog — Plan

**Created:** 2026-10-25
**Status:** Implemented in the working tree, not committed. See "Done" at the end for each batch's files and what was not done.
**Source:** the "Backlog" section of issue #297 (written against `2b14f0a5`),
re-checked against the current tree. Out of scope (handled elsewhere): the nine
branches merged in #298, the post-cancel `waitUntil` in `model-proxy.ts`,
reasoning-token pricing, per-image workflow charges, the unpriced models.dev rows.

Each batch below can be run by one agent without touching another batch's
files, except where "Depends on" says otherwise. B9–B12 add test files only.

## Status of the backlog claims on the current tree

**Fixed (no work):**

| Claim                                                                   | Evidence now                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two music models dropped from `GATEWAY_MUSIC_MODELS` for lacking a cost | All four `mode: "music"` rows in `packages/ai/src/models/registry.ts` (~4235-4340) carry `gatewayKey` and `costPerMusicGenerationMicrodollars`.    |
| No tests on `auth/team.ts`, `auth/api-keys.ts`, `billing/checkout.ts`   | `auth/team.test.ts`, `auth/api-keys.test.ts`, `billing/checkout.test.ts` exist.                                                                    |
| `query-classifier.ts` / `task-detector.ts` untested                     | `chat/lib/query-classifier.test.ts` and `chat/lib/task-detector.test.ts` exist. The deprecation itself is D8.                                       |
| `wrangler` 4.149 → 4.151, `@cloudflare/vite-plugin` 1.63 → 1.64        | The catalog has `wrangler: 4.151.2` and `@cloudflare/vite-plugin: 1.64.0`.                                                                         |
| AGENTS.md checks a non-existent `alchemy` `beta` dist-tag               | AGENTS.md has no such check now (it says "until a newer beta is a day old").                                                                      |

**Partly fixed:**

| Claim                                                          | Now                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistentStreams`/`Chunks` never purged; sweep scans history | The scan is fixed: `chat/streaming/persistent/crons.ts#cleanupExpiredStreams` filters status in SQL, and `crons.test.ts` pins it. The purge is still missing (B5).                          |
| `usage/notifications.ts` untested                              | `usage/tracker.notifications.test.ts` covers `evaluateRules`. The rest is in B9.                                                                                                            |
| `chat/execute.ts` untested                                     | Only `execute.continuation-lock.test.ts` exists (2 cases). The rest is in B11.                                                                                                              |
| `/v1/chat/media` kick-off leaves "generating…" forever         | A refusal creates no row; it is silent in the client (B3). Unstamped pending rows from the agent tools and workflows have no reaper (B5).                                                  |
| `aiUserPreferences` read twice per run                         | The claim names the wrong query: `loadRunContext` reads `userSettings`. The row IS read by three queries per run (`getAgentModulePreferencesQuery`, `getDecryptedProviderKeysQuery`, `getMCPServersQuery`). See D7. |

**By design:** PR CI runs only the affected projects, but
`.github/workflows/full-test.yml` runs the whole tree on every push to main and
nightly. The missing root `pnpm test` is D5.

Everything else in the backlog still holds. It is planned below.

## Priority order

| P   | Batch                                          | Why                                                               |
| --- | ---------------------------------------------- | ----------------------------------------------------------------- |
| P1  | B1 Invite redemption never downgrades          | Access control: a `read` link takes away a collaborator's `write`. |
| P1  | B2 Paused messenger answers 200                | Slack/Meta disable the endpoint, so un-pausing does nothing.      |
| P1  | B3 Media kick-off surfaces refusals            | A refused media request (such as the daily limit) is silent.      |
| P1  | B4 Coding-agent PR reaper                      | A lost poll blocks "Open PR" on that run forever.                 |
| P2  | B5 Shard sweeps: stream purge, stuck media rows | Unbounded table growth; "generating…" placeholders that never end. |
| P2  | B6 Brief + reflection reschedule               | A late alarm stops the daily job until the user chats again.      |
| P2  | B7 Orphan cleanup                              | Stray vectors, vault files and shard routes.                      |
| P2  | B8 Fire-and-forget calls in actions            | Work is cut off when the action returns.                          |
| P3  | B9–B12 Tests                                   | Privilege and money boundaries, and the run path.                 |
| P4  | B13 Cleanup, B14 Deps, B15 God modules         | Debt.                                                             |

---

## B1 — Invite redemption keeps the higher permission (P1)

- **Goal:** redeeming an invite never lowers an existing grant.
- **Files:** `backend/lunora/pages/sharing.ts` (`redeemPageInvite`, ~296-300),
  `backend/lunora/chat/sharing.ts` (accept thread invite, ~386-391).
- **Steps:**
  1. Pages: when `existing` is found, patch only if
     `!meetsPagePermission(existing.permission, invite.permission)` (the helper
     is in `pages/logic.ts:39`). The invite is still spent.
  2. Threads: apply the same rule. If no thread permission-rank helper exists,
     add one next to the thread permission type. Do not inline a second ordering.
  3. Keep the `alreadyHadAccess` log event, and add `kept: true|false`.
- **Tests:** for pages and threads: a `write` grantee who redeems a `read` invite
  keeps `write`; a `read` grantee who redeems a `write` invite gets `write`.
- **Behaviour change:** an invite can only raise access. Lowering access goes
  through the grant editors (`updatePageGrant`, thread access), which do not change.
- **Depends on:** none.

## B2 — A paused messenger connection answers 200 (P1)

- **Goal:** platforms keep the endpoint alive while a connection is paused.
- **Files:** `backend/lunora/messenger/webhooks.ts` (`resolveConnectionAndKeys`
  ~70-110, header comment ~15-25), plus every adapter call site in
  `backend/lunora/messenger/` that maps `null` to `unauthorized()`.
- **Steps:**
  1. `resolveConnectionAndKeys` also returns `paused` connections, with
     `isPaused: true`. `disconnected`, unknown and wrong-platform connections stay
     `null`, which answers 401, so the response still reveals no ids.
  2. Each adapter verifies the signature as it does now. Then, if `isPaused`, it
     answers 200 and drops the message without a claim, pairing or reply. The
     platform handshakes (Slack `url_verification`, Meta `hub.challenge`) are
     still answered.
  3. Update the header comment: a paused connection is an authenticated
     rejection, so it answers 200.
- **Tests:** for at least Slack, Telegram and WhatsApp:
  - paused with a valid signature → 200, and no message is saved;
  - paused with a bad signature → 401;
  - disconnected → 401.
- **Risk:** the signature check must still run for paused rows.
- **Depends on:** none.

## B3 — Media kick-off surfaces refusals (P1)

- **Goal:** when a `/v1/chat/media` request fails or is refused, the user is told.
- **Finding:** both call sites in
  `apps/web/src/features/chat/core/context/chat-context.tsx` use
  `fetch().catch(...)`: send (~1156-1178) and regenerate (~1399-1416). `fetch`
  does not reject on 4xx/5xx, so the client swallows every refusal from
  `chat/http.ts#mediaGenerationHttpAction`, such as the 403
  `DAILY_MESSAGE_LIMIT_REACHED`, a 401 or a 404.
  - No pending row exists yet at that point: `/chat/start` creates no stream
    for media, and the queued generate action creates the row.
  - A queued run that dies is already failed through `runJobOnce` →
    `chat/media-abandon.ts`.
- **Files:**
  - new `apps/web/src/features/chat/core/lib/start-media-generation.ts`, with a test;
  - `chat-context.tsx`: both call sites call the new helper.
- **Steps:**
  1. The helper posts the request, checks `response.ok`, parses
     `{ error, message, retryAfter }`, and returns a typed result. A network
     error also becomes a result.
  2. On failure, show the chat error UI that `/chat/start` failures use, with the
     same daily-limit wording. Clear any sending/regenerating state. Log through
     `providerLogger`.
- **Tests:**
  - helper unit tests with msw: 200, 403 daily limit, 500, network error;
  - one context test: a 403 shows the limit message.
- **Behaviour change:** refusals become visible. No request is retried automatically.
- **Depends on:** none. B15's split of `chat-context.tsx` waits for this.

## B4 — Coding-agent PR reaper (P1)

- **Goal:** a PR attempt whose poll chain is lost ends as failed and can be retried.
- **Files:**
  - `backend/lunora/coding-agents/functions.ts`: the `startPullRequest` claim
    (~636-655) and the PR finish (~698-730);
  - `backend/lunora/coding-agents/execute.ts`: next to `reapRun` (~525).
- **Steps:**
  1. When the PR is claimed, schedule `reapPullRequest` at the PR script's budget
     plus `REAPER_GRACE_MS`. Mirror the run reaper at `functions.ts:312`.
  2. `reapPullRequest` acts only if `prStatus === "pending"` and `prStartedAt` is
     still the value it was scheduled for. It then:
     - marks the PR failed, with the same patch as the failure path (this clears
       `prStartedAt`);
     - kills the PR sandbox if one is recorded;
     - notifies the user the way a failed PR does now.
  3. As a backstop, the claim treats a `pending` older than budget plus grace as
     stale, and claims it again.
- **Tests:**
  - a stuck pending PR is failed by the reaper, and `canOpenPullRequest` is true again;
  - a reaper scheduled for an older `prStartedAt` does nothing;
  - a finished PR is not touched.
- **Risk:** if the script had already pushed its branch when the PR was reaped,
  the branch is left with no PR. Name the branch in the failure message.
- **Depends on:** none.

## B5 — Shard sweeps: purge finished streams, fail stuck media rows (P2)

- **Goal:**
  - `persistentStreams` / `persistentChunks` stop growing forever;
  - a pending media row that no job stamped stops spinning.
- **Files:**
  - new `backend/lunora/chat/streaming/persistent/purge.ts`;
  - new `backend/lunora/chat/media-stale.ts`;
  - `backend/lunora/lib/shard-housekeeping.ts`: two `shardSweeps()` entries.
- **Steps:**
  1. Stream purge:
     - First confirm nothing reads a finished stream's chunks after the reply row
       is saved: resume-on-reload, `/chat/chunks`, the share view. The retention
       window must cover the longest such reader. Default: 7 days past `expiresAt`.
     - Delete streams with a terminal status and `expiresAt < now - RETENTION`,
       in limited batches. Delete each stream's chunks (`by_streamId_seq`)
       first, then the stream.
     - Neither table is in `lib/audit-triggers.ts#AUDIT_TABLES`, so batching is fine.
  2. Stuck media rows: the generate actions in `chat/functions.ts` (`generateImage`
     ~3998, `generateAudio` ~4293, `generateVideo` ~4452) save a `pending` row
     with a `__*_GENERATING__` marker.
     - When an agent tool calls them (`chat/tools/{image,video}-generation.ts`,
       `canvas-ai.ts`), or a workflow does (`workflow/executor.ts`,
       `workflow/http.ts`, `workflow/media-args.ts`), the row has no job stamp.
       If the action dies there, nothing fails it.
     - Sweep: fail `pending` assistant rows carrying a media marker that are older
       than the longest generation budget plus a margin. Reuse
       `ABANDONED_MEDIA_TEXT` and the patch shape of `failAbandonedMediaJob`.
     - Skip stamped rows: `reapLapsedClaims` owns those.
  3. Register both in `shardSweeps()`, not in `EVERY_MINUTE_JOBS`.
- **Tests:**
  - stream purge: 30+ old finished streams with chunks are removed across
    batches, and pending, streaming and recent rows stay;
  - media: an old unstamped pending row is failed, while a fresh one and a stamped
    one are not touched.
- **Risk:**
  - Purging a stream that a client still polls breaks that client. That is why
    the stream must be terminal and past the window.
  - If the media threshold is set below the slowest video model, it fails live
    renders. Derive it from the registry or the gateway timeout.
- **Depends on:** none.

## B6 — Daily Brief and memory reflection reschedule after a missed window (P2)

- **Goal:** a run that lands outside its local window (a late alarm, a timezone
  change, DST) books the next window instead of going quiet.
- **Files:** `backend/lunora/notifications/daily-brief.ts` (claim ~150-170),
  `backend/lunora/memory/reflection.ts` (claim ~175-190).
- **Steps:**
  - Only for the `outside_window` reason, and only if the user is still enabled
    and recently active: `runAt` the next window (`nextBriefRunAt` /
    `nextReflectionRunAt`) and store `scheduledFor`/`scheduledJobId` instead of
    clearing them.
  - Every other reason still clears them.
- **Tests:**
  - An `outside_window` claim leaves exactly one job, at the next local window.
  - That time is strictly later than now, and passes eligibility in the same
    zone. This guards against a reschedule loop.
  - `disabled` and `inactive` still clear.
  - Nothing is double-booked when activity already scheduled a later job.
- **Risk:** a wrong next-window computation would loop through the scheduler.
  The strictly-later test above covers it.
- **Depends on:** none.

## B7 — Orphan cleanup (P2)

- **Goal:** a failure or a delete leaves no vector, vault file or shard route behind.
- **Files:**
  - `backend/lunora/knowledge/ingest.ts` (~270-310);
  - `backend/lunora/public-api/routes.ts` (`createKnowledgeFile`, ~670-680);
  - `backend/lunora/pages/functions.ts` (`deletePageRows`, ~361);
  - `backend/lunora/chat/functions.ts` (`deleteThread` ~1892, `deleteThreads` ~1937).
- **Steps:**
  1. Ingest: wrap the `saveChunks` call. If it throws, run
     `delete_embeddings.deleteEmbeddingsBatch` for `embeddingIds`, then rethrow;
     the outer catch marks the file failed. This is the only gap: anything that
     fails after `saveChunks` leaves chunk rows, and file removal follows those.
  2. Public API: if `knowledge.functions.addFile` throws (for example on quota),
     delete the vault file just saved (`vault.functions.deleteAttachments` with
     its id), then rethrow.
  3. Pages: in `deletePageRows`, if the page has a `publicAccessToken`, call
     `deleteShardRoute(ctx, "page-public", token)`.
  4. Threads: the delete leaves the `thread-public` / `thread-share` routes, and
     today only the share toggle in `chat/sharing.ts` removes them. Remove them
     on delete as well.
- **Tests:**
  - `saveChunks` throws → the vectors are deleted;
  - a quota-refused public create leaves no vault file;
  - deleting a public page, or a shared thread, removes its route.
- **Behaviour change:** a quota-refused public-API create still uses up its
  staged upload, so the client has to upload again (that is how it works today).
  State this in the route's description.
- **Depends on:** none. B15's split of `chat/functions.ts` comes after this batch.

## B8 — No fire-and-forget calls at the end of actions (P2)

- **Goal:** work that an action starts finishes, or is scheduled, before the action returns.
- **Files:** `backend/lunora/memory/extract.ts:584`,
  `backend/lunora/chat/lib/agent-run.ts:491`.
- **Steps:**
  - `maybeCompressThreadMemories`: change it to `ctx.scheduler.runAfter(0, …)`.
  - `patchMessageTiming`: keep the promise and await it before the function
    returns. It is a cheap mutation.
  - Neither call may throw into its caller.
- **Tests:** extract schedules the compression; the timing patch is awaited
  (check the spy order).
- **Behaviour change:** compression runs as its own scheduled job, with its own budget.
- **Depends on:** none.

## B9 — Gateway tests (P3)

- **Goal:** cover the gateway's routing and usage modules, which have no tests now.
- **Files:**
  - new `services/llm-gateway/src/routing/{classifier,momentum,specificity}.test.ts`;
  - new `src/usage/aggregator.test.ts`;
  - new `src/usage/notifications.test.ts`, for everything past `evaluateRules`.
  - It may extend `src/__tests__/helpers/mock-env.ts` if its D1 stub lacks the
    queries the aggregator runs.
- **Steps:**
  - Write table-driven tests for the pure modules.
  - Test the aggregator against the mock env.
- **Risk:** none. Only test code changes.
- **Depends on:** none.

## B10 — Backend auth/billing tests (P3, new files only)

- **Goal:** real-handler tests on the privilege and money boundaries.
- **Files:**
  - new `backend/lunora/auth/admin.test.ts` and `auth/billing.test.ts`;
  - new `auth/organization.test.ts`, covering only the read procedures that D2 keeps.
- **Steps:** drive the real handlers with `@lunora/testing`, not the mocked
  registry of `authz-regressions.test.ts`. Cover:
  - a non-admin is refused and an admin is allowed;
  - `setMemberCreditOverride` and `setOrganizationBillingTier` are platform-admin only;
  - `assertOwnOrganizationId` is enforced;
  - a member cannot read another organization.
- **Risk:** none. Only test code changes.
- **Depends on:** D2 sets the scope of `organization.test.ts`.

## B11 — `chat/execute.ts` tests (P3, new files only)

- **Goal:** test the path that runs and bills every turn.
- **Files:** new `backend/lunora/chat/execute.run.test.ts`.
- **Steps:** mock `lib/services`, as `voice/speech.test.ts` does. Cover:
  - a redelivered job returns quietly (claim-once);
  - a run records usage through `scheduleReplyUsage`;
  - a failed model call finishes the stream and resets the thread;
  - a skill command skips the group config.
- **Risk:** none. Only test code changes.
- **Depends on:** none.

## B12 — Web auth/billing tests (P3, new files only)

- **Goal:** first tests for `features/billing` (3 source files, 0 tests), and the
  riskiest `features/auth` flows (132 source files, 9 tests).
- **Files:** new tests beside:
  - the billing components;
  - `features/auth/lib/invite-token.ts`;
  - `lib/auth/route-guard.ts` (`requireSession`);
  - the sign-in/up error states.
- **Risk:** none. Only test code changes.
- **Depends on:** none.

## B13 — Cleanup (P4)

- **Goal:** remove duplicate helpers, dead code and oversized images.
- **Steps:**
  1. One `formatFileSize`: keep
     `packages/ui/src/components/file-renderers/file-type-utilities.tsx#formatFileSize`.
     - Replace the copies in
       `apps/web/src/features/settings/components/knowledge/knowledge-base-settings.tsx:61`,
       `apps/web/src/features/vault/lib/utilities.ts:1` and
       `apps/web/src/features/local-models/lib/ollama-pull.ts:101` (`formatBytes`).
     - Leave the copy in `data-grid-cell-variants.tsx` for B15.
  2. One backend `sleep`: use `chat/tools/utilities.ts#sleep` in
     `chat/lib/device-tools.ts:125` and in `public-api/stream.ts:96`. The
     generated SDK code is not ours, so leave its copies.
  3. Dead code:
     - Delete `apps/web/src/features/layout/components/featurebase-widget.tsx`
       (nothing imports it).
     - Delete `useUIState` from `features/layout/hooks/use-ui-state.ts`. Grep for
       callers first; `useUIStateStore` stays.
     - Remove the `@deprecated` props from `packages/ui/src/components/tooltip.tsx`
       and `image-gallery.tsx`, once grep shows no caller passes them.
  4. Images:
     - Delete the unreferenced copy `apps/web/public/images/background.jpg`
       (965 KB). Grep emails, OG images and docs first.
     - Re-encode `features/marketing/assets/background.jpg` (progressive JPEG or WebP).
     - Re-encode `public/images/cinema/f_4.webp`, `f_1_4.webp` and `f_11.webp`
       (390–430 KB each).
- **Behaviour change:** the file-size copies format differently (units,
  decimals), so a size string can change. Check each call site.
- **Depends on:** none. Does not touch `package.json` or the lockfile (that is B14).

## B14 — Dependencies (P4)

- **Goal:** remove an unused dependency and bump three dependencies that lag.
- **Files:** `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `packages/ui/package.json`.
- **Steps:**
  1. Remove `react-icons` from `packages/ui/package.json`. Nothing imports it.
  2. Bump `better-auth` (now 1.7.7), `ai` (now 7.0.137) and `alchemy` (now
     beta.81). Take for each the current release that is past
     `minimumReleaseAge`, not the versions in the issue.
     - better-auth: run `auth.schema.test.ts` and `auth.rate-limit.test.ts` afterwards.
     - alchemy: follow the bump steps in AGENTS.md: `lint:types:deploy`, the three
       `deploy-*.test.ts`, then a `dry_run` deploy on preview.
  3. Run `pnpm dedupe` twice and compare the lockfile hashes.
- **Risk:**
  - A better-auth bump can break every auth request through `SchemaMismatchError`.
  - An alchemy beta can move APIs.
- **Depends on:** none. Run it on its own, because it changes the lockfile.

## B15 — God-module splits (P4; last; one file per agent)

- **Goal:** split the five largest modules into readable sibling files.
- **Files:**
  - `backend/lunora/chat/functions.ts` (6,341 lines, 85 exports):
    - split by concern into sibling files;
    - keep every `api.*`/`internal.*` path, or update all its callers and
      `authz-matrix.md`;
    - run codegen twice, and compare the `unknown>` count with the count before.
  - `backend/lunora/agent/client/index.ts` (1,977).
  - `apps/web/src/features/chat/core/context/chat-context.tsx` (1,812).
  - `packages/ui/src/hooks/use-data-grid.ts` (3,304) and
    `packages/ui/src/components/data-grid/data-grid-cell-variants.tsx` (2,169).
    Fold the local `formatFileSize` into the shared one while there.
- **Risk:** churn in the `api.*` paths, which ripples into generated code, the
  authz matrix and clients.
- **Depends on:** B3 (`chat-context.tsx`), B7 (`chat/functions.ts`), B8, and any
  other batch that touches the same file.

---

## Decision needed

| #   | Item | Recommendation |
| --- | ---- | -------------- |
| D1  | **The gateway `/v1` SaaS surface is dormant.** `bearerAuth` (`middleware/auth.ts:51-80`) reads `api_key_cache`. Nothing writes that cache and no `gk_*` key is ever issued, so every `/v1/*` route behind it refuses every caller. These routers are not mounted in `src/index.ts`: `routes/v1/{audio,classify,images,logs}.ts`, `routes/metrics.ts`, `routes/internal/admin-analytics.ts`. `/v1/videos` and `/v1/music` accept only `bearerAuth` and have no live caller; only the marketing page lists them. | **Delete** the six unmounted routers and their tests now. (Deleting `routes/v1/classify.ts` does not touch `routing/classify.ts`, which `/internal/route` uses.) Keep the mounted `bearerAuth` routes frozen until a product issues keys, then revive them as one project. The items below are dormant for the same reason; do them only if the surface goes live. (a) `UsageReporter.report()` (`usage/reporter.ts:116-126`) also returns `false` for a non-retryable 4xx, which its doc comment says it must not. Make it tri-state. Keep 401 retryable (signing clock skew), and treat only the backend's truly permanent statuses as settled. Only the render consumers act on the result (they defer to `usage/pending.ts`, which retries for about 3.5 days). (b) A video render redelivered while `in_progress` calls the provider again (`routes/v1/video-render.ts:266-320`). Write a "submitted" marker before the call and fail closed on redelivery, as `runJobOnce` does. (c) Music `onSubmitted` only sets a local variable (`music-render.ts` ~330-345). Persist the FAL URLs on the KV job so any redelivery resumes. Sending the requeue before acking is the right order; keep it. (d) The completions fallback paths (`routes/v1/completions.ts:956,1040`) call `recordAndEvaluate` but never `report()`. |
| D2  | **The `auth/organization.ts` mutations cannot succeed.** `getBetterAuthApi` (line 52) passes an empty `Headers()`, so better-auth's session-gated endpoints refuse every call. It is reached directly or through `hasPermission`. The 11 mutations affected: `createOrganization`, `updateOrganization`, `setActiveOrganization`, `acceptInvitation`, `rejectInvitation`, `removeMember`, `leaveOrganization`, `updateMemberRole`, `deleteOrganization`, `inviteMember`, `cancelInvitation`. None is called from web, the CLI, the extension or the public API; web uses `authClient.organization.*`. Five queries also have no caller: `getActiveMember`, `getOrganization`, `getOrganizationOverview`, `listMembers`, `listPendingInvitations`. | **Delete the 11 mutations and the 5 unused queries.** Keep `checkSlug`, `listOrganizations` and `listUserInvitations`, which web uses. Update `docs/security/authz-matrix.md` and its guard test, and run codegen. Do not write tests for the deleted procedures. |
| D3  | **`triggers.timezone` is stored and never read.** `triggers/schedule.ts:149` says cron expressions are "UTC by contract", but the settings UI (`trigger-settings.tsx:152,399`) asks for a timezone and defaults it to the browser's. | **Honor it.** Evaluate the cron in the trigger's zone with `localParts`/`resolveTimeZone` (`notifications/daily-brief-logic.ts`), and read a missing zone as UTC so existing rows keep their behaviour. Pin DST in tests. If that is too much for now, hide the field and label schedules "UTC". |
| D4  | **The composer's TipTap stack loads eagerly on the chat route** (`chat/thread/composer-input-area.tsx:32-33`). It is the main input, so `lazy()` delays the first keystroke. | **Measure first** (the `bundle.yml` artifact). Lazy-load it only if the gzip saving is real, and only with a plain-textarea fallback that keeps what the user has typed. |
| D5  | **There is no root `pnpm test` / `pnpm verify`.** AGENTS.md documents this. | Add a root `verify` script (`lint` + `lint:types` + `vis run test`) as a convenience. Keep `pnpm test` absent. |
| D6  | **Request bodies are buffered before the size cap** (`public-api/router.ts:72-83`, `triggers/http.ts` ~127-140). `Content-Length` is checked first, so only chunked bodies get past the cap. Workers cap memory anyway. | Accept it. At most, add a one-line comment at each site. |
| D7  | **`aiUserPreferences` is read by three queries per run.** | Leave it: they are shard-local reads. Merge them into one only if B15 splits `agent/client`. |
| D8  | **`execute.ts` relies on the `@deprecated` `query-classifier.ts` (1,051 lines) and `task-detector.ts`.** Their notes point to `/internal/route`'s classification, but nothing in the backend calls `/internal/route`. | **Un-deprecate both and keep them.** They are local, free and tested, while switching would add a gateway round trip to every turn. Remove the `@deprecated` tags and the "migration" wording. |

---

## Done

Recorded after implementation, for splitting the working tree into commits. Paths are
relative to the repo root. "(new)" marks files that did not exist before.

| Batch | Files | Not done or changed from the plan |
| --- | --- | --- |
| B1 | `backend/lunora/pages/sharing.ts`, `backend/lunora/chat/sharing.ts`, `backend/lunora/pages/functions.test.ts`, `backend/lunora/chat/sharing.accept-invite.test.ts` (new) | `alreadyHadAccess` log event exists only for threads; pages have none. |
| B2 | `backend/lunora/messenger/webhooks.ts`, `backend/lunora/messenger/webhooks.test.ts` | Paused-connection tests cover Telegram, Slack and WhatsApp only. Discord, LINE, Feishu, Teams and WeChat have the same check, untested. |
| B3 | `apps/web/src/features/chat/core/lib/start-media-generation.ts` (new) and `.test.ts` (new); `apps/web/src/features/chat/core/context/chat-context.media-refusal.test.tsx` (new); `chat-context.tsx` | Added a module-level hand-off for the new-thread case (`thread-error-sinks.ts`, 30 s expiry), which the plan did not ask for. Hand-off has no test. `lingui extract` not run. |
| B4 | `backend/lunora/coding-agents/functions.ts`, `execute.ts`, `runner.ts`, `functions.test.ts` | Reaper mirrors `reapRun` with `ctx.scheduler.runAfter` (not `runAfterOnShard`), since the mutation already runs on the user's shard. |
| B5 | `backend/lunora/chat/streaming/persistent/purge.ts` and `purge.test.ts` (new); `backend/lunora/chat/media-stale.ts` and `media-stale.test.ts` (new); `backend/lunora/lib/shard-housekeeping.ts`; `backend/lunora/chat/media-abandon.ts` (exports `stampedJobId`) | Media sweep also covers `__MUSIC_GENERATING__`. Retention is 7 days past `expiresAt`, floored at `PENDING_APPROVAL_TTL_MS`. |
| B6 | `backend/lunora/notifications/daily-brief.ts`, `backend/lunora/memory/reflection.ts`, `backend/lunora/notifications/daily-brief.test.ts`, `backend/lunora/memory/reflection-claim.test.ts` (new) | None. |
| B7 | `backend/lunora/knowledge/ingest.ts` (`keepVectorsOnlyIfSaved`); `backend/lunora/public-api/routes.ts`; `backend/lunora/vault/functions.ts` (`discardUnfiledVaultFile`, internal) and `functions.test.ts`; `backend/lunora/public-api/knowledge-file-refused.test.ts` (new); `backend/lunora/pages/functions.ts`; `backend/lunora/lib/shard-routes.ts` (`deleteThreadShardRoutes`); `backend/lunora/chat/functions.ts` (`deleteThread`, `deleteThreads`) | The plan's step 2 assumed `vault.deleteAttachments` could delete an unfiled vault file. It cannot: it only deletes chat rows, and the vault UI relies on that. The public API uses a new internal mutation instead, and `deleteAttachments` is unchanged. |
| B8 | `backend/lunora/memory/extract.ts`; `backend/lunora/chat/lib/agent-run.ts`; `backend/lunora/chat/execute.ts` and `chat/group/run.ts` (`recordRun` awaited); `backend/lunora/memory/extract.compression.test.ts` and `chat/lib/agent-run.after-run.test.ts` (new) | No test covers a throw from `ctx.scheduler.runAfter` in `extract.ts`. |
| B9 | `services/llm-gateway/src/routing/{classifier,momentum,specificity}.test.ts` (new); `src/usage/aggregator.test.ts` and `notifications.test.ts` (new); `src/__tests__/helpers/sqlite-d1.ts` (new, a real `node:sqlite` D1 adapter); `src/lib/sqlite-time.ts` (new); `src/middleware/daily-limit.ts` (exports the helper); `src/usage/notifications.ts`, `src/usage/aggregator.ts` | The tests found a real bug (see "Found, fixed" below). The fix is in the same working tree. |
| B10 | `backend/lunora/auth/admin.test.ts`, `billing.test.ts`, `organization.test.ts` (new) | The accepting path of `assertOwnOrganizationId` is covered only by `organization-helpers.test.ts`, not through a real handler. |
| B11 | `backend/lunora/chat/execute.run.test.ts` (new) | None. 10 cases. |
| B12 | `apps/web/src/features/billing/hooks/use-checkout.test.tsx`, `use-billing-options.test.tsx`; `components/personal-plan-card.render.test.tsx`; `features/auth/components/auth/forms/sign-in-form.render.test.tsx`, `sign-up-form.render.test.tsx` (all new); extended `invite-token.test.ts` and `lib/auth/route-guard.test.ts` | Tests use placeholders for inputs, because the form labels are not associated (see below). |
| B13 | `packages/ui/src/components/file-renderers/file-type-utilities.test.ts` (new); knowledge-base-settings, vault utilities and `ollama-pull.ts` (shared `formatFileSize`); `apps/web/.../featurebase-widget.tsx` deleted; `use-ui-state.ts` (`useUIState` removed); `image-gallery.tsx` (deprecated props removed); `apps/web/public/images/background.jpg` deleted; `features/marketing/assets/background.webp` (new, replaces `background.jpg`); `landing-page.tsx`; cinema `f_4`, `f_1_4`, `f_11` re-encoded to WebP; `backend/lunora/chat/lib/device-tools.ts` and `public-api/stream.ts` (shared `sleep`); `.po` placeholder comments | `tooltip.tsx` deprecated `delayDuration` kept: four callers still pass it. Size strings change, for example `0 Bytes` → `0 B`, `1 KB` → `1.0 KB`. |
| B14 | `packages/ui/package.json` (`react-icons` removed); `pnpm-workspace.yaml`; `pnpm-lock.yaml` | **Partly done.** `better-auth` stays at 1.7.7: `@lunora/auth` pins `@better-auth/*` exactly, so a bump splits two copies and breaks backend typecheck. `ai` stays at 7.0.137: every newer release breaks typecheck in local agent code. `alchemy` untouched (needs a CI dry-run deploy). |
| B15 | `packages/ui/src/hooks/use-data-grid.ts` (3,304 → 1,660 lines) and `hooks/data-grid/*` (new); `components/data-grid/data-grid-cell-variants.tsx` (barrel) and `data-grid-cell-*.tsx` (new), with the local `formatFileSize` folded in; `packages/ui/AGENTS.md` note; `apps/web/src/features/chat/core/context/` (`chat-context.tsx` 1,862 → 913 lines, plus `send-message.ts`, `branch-actions.ts`, `chat-context-hooks.ts`, `chat-context-types.ts`, `chat-gateway.ts`, `chat-action-shared.ts`, `media-kickoff.ts`, `thread-error-sinks.ts`); `backend/lunora/agent/client/index.ts` (1,977 → 1,318 lines) plus `agent-types.ts`, `tool-approval.ts`, `structured-output.ts`, `message-persistence.ts` (new) | **`chat/functions.ts` split not done.** A probe showed that moving a procedure to a sibling file changes its generated `api.*` path, and a re-export does not keep it. Every caller and the authz matrix would need updating (see the probe result in the report). Needs its own plan. |
| D1 | Deleted: `services/llm-gateway/src/routes/v1/{audio,classify,images,logs}.ts`, `routes/metrics.ts`, `routes/internal/admin-analytics.ts`, `__tests__/audio-upload-limit.test.ts`, `providers/audio-factory.ts`, `providers/image-factory.ts`, `lib/reference-image-mapping.ts` and its test | The dormant-bug fixes (a) to (d) were not done, as the plan says. `services/llm-gateway/README.md`, `docs/services/llm-gateway.mdx` and `apps/web/.../gateway-landing-page.tsx` still list the deleted routes. |
| D2 | `backend/lunora/auth/organization.ts` (16 procedures removed, with `getBetterAuthApi`, `hasPermission`); `docs/security/authz-matrix.md` (16 rows removed) | The `organization/*` rate-limit keys in `lib/rate-limiter.ts` are now unused and left in place. |
| D3 | `backend/lunora/triggers/schedule.ts`, `triggers/functions.ts`, `schedule.test.ts`, `functions.test.ts`; `backend/lunora/memory/reflection-logic.ts` (exports `zoneOffset`) | **Rows shift.** Enabled triggers that stored the browser's zone fire at a different UTC time, one run late. Not migrated. |
| D4 | none | **Not measured.** It needs the CI bundle artifact. Composer TipTap is not lazy-loaded. |
| D5 | `package.json` (`verify` script) | None. |
| D6 | `backend/lunora/public-api/router.ts`, `backend/lunora/triggers/http.ts` (one comment each) | None. |
| D7 | none | Left as decided. |
| D8 | `backend/lunora/chat/lib/task-detector.ts`, `query-classifier.ts` (`@deprecated` and migration wording removed) | None. |

### Found, fixed in this pass

- Gateway usage bounds compared an ISO timestamp against a `YYYY-MM-DD HH:MM:SS` column, so rows on the boundary date were missed. Fixed in `notifications.ts` and `aggregator.ts`.

### Found, not fixed (new, outside the plan)

- **Gateway, same timestamp bug:** `lib/prompt-cache.ts:95` (`getStats`) and `routes/v1/logs.ts:91,96`, where user-supplied `from`/`to` bounds are compared raw.
- **Vault UI:** deleting an unfiled vault file reports success, but `deleteAttachments` only deletes chat rows, so nothing is removed.
- **Invite refusals:** `SIGN_UP_INVITE_REQUIRED` and `SIGN_UP_INVITE_INVALID` have no entry in `ERROR_TRANSLATIONS`, so users see "Request failed".
- **Auth forms:** `FormLabel` points at a wrapper `<div>`, not the input, so sign-in and sign-up inputs have no label-based accessible name. This is a WCAG 2.1 AA issue.
- **Flaky test:** `services/llm-gateway/src/usage/tracker.notifications.test.ts` (batch sizes) failed once in several runs.
