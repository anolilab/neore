# PROJECT KNOWLEDGE BASE

Neore Chat v2 — AI chat application. React + TypeScript frontend, a **Lunora**
backend on Cloudflare Workers, in a `@visulima/vis` + pnpm monorepo.

This file holds what is **non-obvious and still true**. If something here is
derivable by reading the code in under a minute, it does not belong. When you
learn something that would have saved you an hour, add it — here, or in the
nearest scoped `AGENTS.md` (`apps/web/src/`, `backend/lunora/`).

## STRUCTURE

```
./
├── alchemy.run.ts          # Alchemy IaC — deploys every Worker + D1/R2/Vectorize/Queues
├── apps/
│   ├── web/                # Main React app (TanStack Start)
│   ├── browser-extension/  # CRXJS + React
│   └── native/             # Tauri v2 desktop/mobile shell around the DEPLOYED web app
├── backend/                # Lunora backend (ShardDO + .global() D1 + R2), Better Auth
├── packages/
│   ├── ai/                 # MODEL_REGISTRY, prompts, design presets, tool defs
│   ├── chat-ui/            # Chat primitives (composer, thread) — no backend/auth/router imports
│   ├── service-sdk/        # Typed client for the Workers services
│   └── ui/                 # Base UI component library
├── services/               # 5 Hono Workers: llm-gateway, document-parser,
│                           #   browser-renderer, embeddings, nsfw-checker
└── docs/                   # User-facing docs tree
```

## WHERE TO LOOK

| Task             | Location                                                        |
| ---------------- | --------------------------------------------------------------- |
| App entry        | `apps/web/src/routes/__root.tsx` (file-based routing)           |
| Backend          | `backend/lunora/` — schema, auth, chat, GDPR                    |
| Chat features    | `apps/web/src/features/chat/`                                   |
| Auth             | `apps/web/src/features/auth/`                                   |
| AI models        | `packages/ai/src/models/registry.ts`                            |
| Canvas/artifacts | `apps/web/src/features/canvas/`                                 |
| Design presets   | `packages/ai/src/design/`                                       |
| Prompt optimizer | `packages/ai/src/prompts/optimizer/`                            |
| LLM Gateway      | `services/llm-gateway/src/`                                     |
| Gateway client   | `backend/lunora/chat/lib/gateway-client.ts`                     |
| Gateway proxies  | `backend/lunora/chat/lib/gateway-{language,embedding}-model.ts` |
| Edge streaming   | `backend/lunora/chat/streaming/persistent/`                     |
| Agent execution  | `backend/lunora/chat/execute.ts`                                |
| Infrastructure   | `alchemy.run.ts`                                                |
| Public API / CLI | `backend/lunora/public-api/`, `apps/cli` (`neore`)              |

## CONVENTIONS

- **vis workspace**: pnpm workspaces + `@visulima/vis`, strict TypeScript.
- **Target projects by their `package.json` name.** `vis` ignores
  `project.json#name` — `--projects=@neore/web`, never `--projects=chat`.
- **Feature-based**: `apps/web/src/features/<domain>/`.
- **cRPC** (`@/lib/lunora/crpc`, over `@lunora/react`) for every backend
  query/mutation — see `apps/web/src/AGENTS.md`.
- **Better Auth** for authentication; use the provided auth factories rather
  than calling better-auth directly.
- TanStack Router (file-based) + TanStack Query (via cRPC); lingui for i18n.
- `vis.config.ts` holds task defaults, `project.json` per-project metadata. In
  `vis.config.ts`, `dependsOn` takes **target names only** — named inputs and
  file globs belong in `inputs`, and vis silently drops them from `dependsOn`,
  **disabling input tracking without saying so**.

## ANTI-PATTERNS

- Never run `lunora deploy` or `pnpm run deploy` unless explicitly instructed —
  CI owns deployment.
- Never run git commands unless explicitly instructed.
- Never run `dev:*` unless explicitly instructed.
- Use `internal*` Lunora functions for sensitive operations.
- All external API calls belong in actions, never queries/mutations.

## COMMANDS

Always `pnpm`.

```bash
# Type checking / lint  (lint does NOT include types — run both)
pnpm lint:types           # vis run lint:types — use this, NOT `pnpm typecheck`
pnpm lint                 # prettier + eslint + dedupe check
pnpm lint:eslint:fix
pnpm lint:prettier:fix

# Tests — there is NO root `pnpm test`
pnpm vis run test         # everything
pnpm test                 # inside a project directory

# Build
pnpm build:packages
pnpm --filter @neore/backend run build     # backend Worker + binding manifest

# Backend codegen
cd backend && pnpm codegen

# Deployment (CI does this; do not run locally)
# Since pnpm 11 a script named `deploy` (also `clean`, `setup`, `rebuild`)
# SHADOWS the built-in, so bare `pnpm deploy` now RUNS alchemy.run.ts — it no
# longer fails harmlessly with ERR_PNPM_NOTHING_TO_DEPLOY as it did on pnpm 10.
# Write `pnpm run deploy` anyway; `pnpm pm deploy` is the built-in.
DEPLOY_ENV=preview pnpm run deploy
```

**pnpm is 12.x** (`packageManager`; a global pnpm switches to it per
project). Settings live ONLY in `pnpm-workspace.yaml` — `.npmrc` is read for
auth/registry alone, and since 12 an UNKNOWN key there fails every command
(`ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS`) instead of being ignored. Build
scripts are allowed through the `allowBuilds` map (values must stay booleans)
and `strictDepBuilds` is on, so a new dependency with an install script fails
`pnpm install` until it is listed. `autoInstallPeers` is OFF: a REQUIRED peer
(packem's `@visulima/packem-rollup`) must be declared by the package that uses
it, and `pnpm peers check` lists what is missing — most of it optional in
practice (framework adapters of `@visulima/storage-client`, `@lobehub/ui`/`antd`
for `@lobehub/icons`). An UNDECLARED optional peer that some other package
happens to provide can make `pnpm dedupe` flip-flop between two lockfiles on
every run (packem's `rollup`, now declared), so `pnpm dedupe --check` never
passes — run `pnpm dedupe` twice and compare hashes after a big bump.
`minimumReleaseAgeStrict` is on by default in 12 (we set `minimumReleaseAge`),
so a too-young version fails the install rather than falling back. pnpm 12 is a
native (Rust) binary: on a machine with a per-app firewall (OpenSnitch) each
release needs its own allow rule — unapproved, `install`/`audit`/`dedupe`/`view`
hang until a DNS error while `pnpm run` still works. Corepack 0.34 cannot run
it at all (it fetches no `@pnpm/exe.*` binary). CI's `pnpm/action-setup` v6.1
does; the lock-file-maintenance workflow (anolilab/workflows
`pnpm-lock-file-maintenance.yml`) pins `step/setup@9b64c8ce`, which is still on
action-setup v6.0.10 and cannot install 12 — that pin has to move upstream.

Root prettier only covers `*.{json,yml,yaml,js,mjs,cjs,ts}` — **root markdown is
not linted**, so do not "fix" its formatting.

## SUBSYSTEMS

Locations and invariants only. The behaviour is readable from the code; what is
written here is what is not.

- **AI model registry** — `packages/ai/src/models/registry.ts` is the single
  source for every model (text/image/video/music). `listed: true` puts a model
  in marketing catalogs; `enabled: false` hides it everywhere;
  `provider: "external"` is listed-only and skipped by agents.
  `IMAGE_CATALOG`/`VIDEO_CATALOG`/`TEXT_CATALOG` are derived via `deriveCatalog()`.

- **LLM Gateway** (`services/llm-gateway/`) proxies **all** LLM and embedding
  calls for token counting, cost tracking and smart routing. D1 for usage,
  separate KV namespaces for rate limits and pricing. `/v1/*` is the public
  surface the browser posts to; `/internal/*` (and the backend-only `/v1/usage`,
  `/v1/cache`, `/v1/events`…) are served ONLY to the backend's service binding —
  see "Services" below. The backend plugs in via `gateway-language-model.ts` /
  `gateway-embedding-model.ts`, which implement `LanguageModelV3` /
  `EmbeddingModelV2` and serialise call options over the binding's `fetch` — so
  every LLM call routes through the gateway with no change to tool execution,
  persistence or the agent loop. `LLM_GATEWAY_SIGNING_SECRET` is now only the
  gateway -> backend direction (chunk polling, usage reports, key validation,
  stream tokens). Billing: 1 credit = 1,000 microdollars, via
  `deductCreditsFromGateway`.

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
      `SERVICE_DOCUMENT_PARSER: documentParser`, `SERVICE_LLM_GATEWAY:
      Worker.experimentalEntrypoint(llmGateway, "InternalApi")`), and the three
      private Workers get `url: false` — Alchemy does not read their
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
      docs/plans/document-parser.md). Its `wrangler.jsonc` `build.command` is
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
      Alchemy uploads `build/` as built (`noBundle`) and refuses to start
      without it. The 25 MB document cap is one number in three places —
      `src/shape.rs#MAX_DOCUMENT_BYTES`, `lib/document-limits.ts` (backend, and
      the composer through `@neore/backend/document-limits`) —
      `lib/document-limits.test.ts` pins that they agree.

- **Edge streaming** — agent execution is decoupled from SSE delivery. The agent
  loop runs as a background job on the JOBS QUEUE (not the scheduler — see
  "Scheduler" below) (`backend/lunora/chat/execute.ts:runStreamingAgent`),
  claims its stream once (`claimStreamRun`) and writes to
  `persistentChunks`; the client streams from the gateway, which polls
  `/chat/chunks` and relays NDJSON. Stream token is HMAC
  `{streamId}:{userId}:{threadId}:{expiresAt}:{hmac}`, 30 min TTL.

- **Video render queue** — `POST /v1/videos` enqueues and returns 202; the
  Worker's `queue()` handler consumes it. **Cross-config invariant:**
  `VIDEO_RENDER_MAX_ATTEMPTS = 3` in the consumer MUST equal `maxRetries: 2`
  (+ initial delivery) on `eventSources` in `alchemy.run.ts` — a mismatch
  silently drops messages on the final attempt, before the DLQ. Provider keys go
  in `CACHE_KV` under `video_render_secret:{jobId}` (TTL 2h) so the queue payload
  never carries secrets. `markRenderFailed` is idempotent and is called from both
  the render core (non-retryable) and the consumer (retries exhausted, because
  the core leaves the row `in_progress` between attempts).

- **FAL media** — music has no AI SDK V3 primitive, so the gateway calls FAL's
  queue API directly (`providers/music-factory.ts`). Response shapes vary per
  model, so the shape-guessing is isolated and unit-tested on both sides:
  `extractAudioPart` (gateway) and `backend/lunora/chat/lib/fal-media-parsing.ts`
  (`extractFalAudioUrl`, `resolveFalVideoUrl`). Video content-type resolution
  deliberately ignores `output.content_type` and falls back to `video/mp4`.

- **Multi-reference images** — `MODEL_REGISTRY.maxReferenceImages` (1/2/4) is the
  source of truth; the cap is enforced at three boundaries (backend action,
  gateway request schema, gateway media middleware). FAL always gets
  `image_url: string`; multi-ref models additionally get `image_urls: string[]`
  via `buildFalReferenceImageInput`, FAL-gated.

- **Browser automation** — `browserTool` runs through the Cloudflare Browser
  Rendering worker via `@neore/service-sdk/browser-renderer`. There is no
  Browserbase/Playwright path any more and `BROWSERBASE_API_KEY` does nothing;
  `browser-node.ts` gates on the `SERVICE_BROWSER_RENDERER` binding alone
  (`isServiceBound`), and the tool has no env requirement. The SSRF guard
  `validateDomain` lives in `tools/utilities.ts`, not `browser-node.ts`, so the
  security suite imports the real function rather than a copy.

- **User memory** — extraction runs as a background action after each AI
  response; retrieval runs before generation with multi-signal scoring
  (semantic 0.40 / confidence 0.20 / importance 0.15 / recency 0.25, 30-day
  half-life). Dedup threshold 0.85; conflicts go through belief revision
  (UPDATE/SUPERSEDE/IGNORE/ADD). **`memoryEnabled` on `userSettings` is OPT-IN —
  absent means off.** `isMemoryEnabled` is the authoritative gate; the settings
  read and the UI fallback must agree with it. It defaulted to ON, which meant
  extraction ran over every conversation for users who had never seen the
  setting.
  **Taxonomy** is `memory/taxonomy.ts` (identity / preference / context /
  activity / experience), a required `type` column.
  **Nightly reflection** (`memory/reflection*.ts`) uses NO cron: `afterRun`
  schedules `noteMemoryActivity`, which `runAt`s one run at the user's local
  03:xx, so only users active in the last day ever have one queued. Only
  `activity` decays; pinned rows are never decayed, merged away or promoted. The
  LLM only words merges/promotions/the digest — WHICH rows change is decided by
  the pure, tested planner. Injected memories are recorded on the reply's first
  row (`messages.retrievedMemories`) for the "memories used" popover.

- **Usage rollup** (`backend/lunora/usage/`) — the usage page's heatmap and
  per-skill breakdown read `usageDaily`, never messages. EVERY run path records
  through `usage/schedule.ts#scheduleReplyUsage` (afterRun, `runHeadlessAgent`,
  the Daily Brief) — a new run path that skips it is missing from the page.
  A reply is keyed on its FIRST reply row id in `usageReplies`, which both
  the live record and the one-shot backfill (`usage/backfill.ts`) check, so
  redelivery and backfill/live overlap count once; the backfill's reply
  grouping (`backfill-logic.ts#groupReplies`) must keep matching what one run
  saves, or its keys stop lining up with the live ones. Keys are pruned only
  after the user's backfill is done.

- **Prompt optimizer** — templates ported (MIT) from linshenkx/prompt-optimizer
  as plain TS in `packages/ai/src/prompts/optimizer/`. User input is wrapped as
  JSON via `toJson` and the model is told to treat strings as **evidence, not
  instructions** — that is the prompt-injection defence, do not unwrap it. The
  renderer substitutes in a **single left-to-right pass** so values containing
  `{{var}}`-like syntax are not re-substituted; `render.test.ts` pins this.
  Three backend actions share `runOptimizer` and the `chat/promptImprovement`
  rate-limit family.

- **Connectors** (`backend/lunora/connectors/`) — each is a row pointing at the
  provider's OWN hosted MCP server; OAuth is discovered from that server
  (`lib/mcp-oauth.ts`, generic MCP-spec client: PRM → AS metadata → DCR or an
  env client → PKCE). The provider redirects to the APP route
  `/dashboard/settings/connectors/callback`, not the backend, because
  completion must run as the signed-in user to check the `state` owner — a
  top-level redirect carries no bearer JWT. Connected grants join chat as MCP
  servers keyed `connector:<slug>:<tool>`. GitHub Actions reserves secret names
  starting `GITHUB_`, so `GITHUB_CONNECTOR_*` is fed from `CONNECTOR_GITHUB_*`.

- **Local models (Ollama / LM Studio)** — custom endpoint `type: "local-browser"`:
  the BROWSER calls the loopback server directly (`apps/web/src/features/local-models`),
  then persists text only via `chat_local_models.saveLocalTurn` (no tools, no
  usage, `provider: "local-browser"`, not billed). The server never fetches it and
  `resolveRunModel` refuses it (`local-endpoint`). Regenerate and edit branch to
  the browser in `chat-context.tsx` when the current model is local, and
  `saveLocalTurn({ branch })` saves them as siblings — a regenerate needs
  `failPendingSteps: true` on the reply, or it chains UNDER the old reply
  instead of beside it. **Three lists must agree:** `LOCAL_ENDPOINT_HOSTS`
  (`@neore/ai/models`), `LOCAL_MODEL_CONNECT_SOURCES` in the web CSP, and the
  loopback-only validator — widen one alone and saves succeed that the browser
  then blocks, or the CSP opens the LAN. Safari cannot use it (WebKit upgrades
  `http://localhost` from https pages); Chromium and Firefox exempt loopback.

- **Coding agents** (`backend/lunora/coding-agents/`) — `delegateToCodingAgent`
  (chat tool, built-in that defaults to `ask`) and a task's `codingAgent`
  assignee run Claude Code / Codex in an E2B sandbox on the user's BYOK
  `anthropic`/`openai` key. **No action waits for a run** (up to 20 min): a
  scheduled action is dispatched from the SchedulerDO alarm, and Cloudflare
  caps alarms at 15 min wall time. The sandbox runs a detached script
  (`buildRunScript`: clone, install the PINNED CLI, run the agent, write a
  status file); the backend only starts it, polls its log every 4s, and
  finalizes. The tool returns at once; the result lands as a follow-up
  assistant message (`agentName`) on the active branch, and a task round is
  completed by `finishCodingAgentRound`. **A PR is never pushed from the
  agent's sandbox** — the agent ran untrusted code there — it is rebuilt from
  the stored diff in a fresh sandbox, by a detached script polled the same way
  (`startPullRequest` → `pollPullRequest` → GitHub API). Claude runs with `--bare`: without it,
  `-p` executes the repo's `.claude/settings.json` hooks and `.mcp.json`
  servers. CLI flags are cited in `buildAgentCommand`; re-check them when
  bumping `npmVersion`. E2B itself is unit-tested against a fake only.

- **Notifications, Web Push, home** (`backend/lunora/notifications/`,
  `home/overview.ts`, `apps/web/src/features/{notifications,home}`) — every
  write goes through `notify()` (or `internal.notifications.functions.createNotification`
  from an action): it lands on the RECIPIENT's shard (off it, it is scheduled
  there), is idempotent on `dedupeKey` (queue/workflow redelivery), and
  schedules push only when the user has a subscription. `title` is the
  SUBJECT; the UI words the headline from `type` + `outcome` (push, which has
  no catalog, uses `push-text.ts`). Pruned after 30 days by the housekeeping
  sweep, not a cron. Web Push is `@lunora/notify` (`ctx.push`, configured in
  `lunora/notify.ts`): subscriptions live in its D1 table
  `lunora_push_subscriptions` (lazily created, owner-scoped — not a schema
  table, so not on the user's shard; GDPR reaches it via `ctx.push`). The
  endpoint is browser-supplied, so `isAllowedPushEndpoint` (`push-endpoint.ts`)
  allow-lists the push services (SSRF) before `ctx.push.register`. Sign-out
  must unregister (`useReleasePushOnSignOut`), or the next account on that
  browser is refused the endpoint (`taken`). VAPID keys are
  OPTIONAL — unset, push is off. The SW handlers are `public/push-sw.js`,
  pulled in by `generate-sw.mjs` `importScripts`; there is no SW in dev.
  `/dashboard` is the home, one live `getHomeOverview` query; the bell is one
  live `getNotificationInbox` (after first paint). The Daily Brief is opt-in
  (`userSettings.dailyBriefEnabled`) and scheduled like memory reflection —
  `afterRun` → `noteDailyBriefActivity` → `runAt` local 07:xx — and charged
  via `chargeRound` only when there is something to report.

- **Triggers** — schedule (cron, 1-min polling), webhook (HMAC-SHA256 at
  `/triggers/webhook/{triggerId}`), event (not built). Execution uses headless
  `generateText` with auto-continue; each run creates a new thread tagged with
  trigger metadata.

- **Evals** (`backend/lunora/evals/`, `/evals`) — datasets of cases run against
  a skill, a model + system prompt, or knowledge retrieval, one case at a time
  on the scheduler (claim → `runEvalCase` → complete, like tasks). No cron: each
  claim schedules its own `reapCase`. Every case is charged via
  `tasks/account.ts:chargeRound`, and the per-run cost cap is checked BEFORE
  each case, so a run can overshoot by one case. Cost comes from
  `runHeadlessAgent`'s `costMicrodollars` (gateway pricing summed over steps) —
  absent without the gateway or on an unpriced BYOK key, in which case the cap
  never trips and a `max_cost_usd` check reads "not measured", not failed.
  RAG expected sources are matched by knowledge file NAME (search results
  carry no file id). Case threads are marked temporary (7 days).

- **Ask-user** (`chat/tools/ask-user.ts`) — a question IS a tool-approval
  request: the tool hard-codes `needsApproval: true`, so the pause, snapshot
  and claim are the approval machinery's. It is answered only through
  `chat_ask_user.answerAskUser` (`respondToToolApproval` refuses it — an
  approval with no answer would resume with nothing); the continuation swaps
  in `createAnsweredAskUserTool(answer)` so the answer is the tool result, and a
  dismiss is a denial with a reason. Headless runs drop it whatever its mode
  (`BUILTIN_TOOLS_NEEDING_A_PERSON`). Its constants live in
  `ask-user-constants.ts` because `agent-run.ts` importing the tool module
  (which loads the agent client) breaks the import graph in unit tests.

- **Sub-agents** (`sub-agents/`) — `delegateToSubAgent` admits a
  `subAgentRuns` row (owner of the parent thread only; depth ≤ 2 counted via
  `by_childThreadId`; ≤ 3 queued/running per PARENT THREAD — the tool cannot
  see its run; `subAgents/run` rate limit; one `chargeRound`), then the jobs
  queue runs `runHeadlessAgent` in a child thread linked by a
  `threadRelationships` row with `branchType: "subagent"`. `finishRun` is the
  only end of a run (frees the fan-out slot, notifies); a reaper fails a
  silent run. The post-back is `postRunResult`, once per `resultPostedAt`, and
  WAITS while the parent thread has a pending/streaming `persistentStreams`
  row (backoff, posts anyway after ~36 min) — otherwise it lands between the
  delegating run's own steps. The delegate tool defaults to `ask`, and a
  headless run drops `ask` tools — so the child gets it back through
  `runHeadlessAgent({ approvedTools })` → `headlessApproved`: the parent's call
  only executed past its permission check, and that consent carries down
  (never over `off`, never to other tools, withheld at the depth cap).
  Triggers, tasks and messenger replies inherit nothing, so they lose it.

- **Auto-continue ("Deep Work")** — raises the agent loop from 5 to 25
  `maxSteps`. All triggers use it by default.

- **Chat import** — client parses the export → uploads normalised JSON to R2 →
  `startImportJob` kicks off a `@lunora/workflow` workflow that processes
  conversations in batches of 25. Progress is polled reactively off
  `chatImportJobs`. Parsers for ChatGPT (tree-based `mapping`), Gemini
  (`USER`/`MODEL`) and Claude (`human`/`assistant`) auto-detect from JSON shape.

- **Messenger** — Telegram/Slack/Discord, per-connection webhooks at
  `/messenger/{platform}/{connectionId}`. **BYOK**: bot tokens live in
  `aiUserPreferences.messengerKeys` with the same `{ enabled, encryptedKey }`
  shape as provider keys — no global env vars.
  EVERY platform (plus WhatsApp, LINE, Feishu/Lark, Teams and WeChat beta)
  parses into `InboundMessage` and shares one pipeline
  (`messenger/webhooks.ts#acceptInbound`: freshness → claim-once dedupe →
  pairing → per-connection + per-sender rate limit); adapters keep only their
  signature check and parser. **The claim TTL (`MESSENGER_CLAIM_TTL_MS`, 25h)
  must outlast every adapter's freshness window** (WhatsApp's 24h service
  window, Telegram's 24h retention), or a replay lands after its claim expired
  yet still looks fresh. Feishu REQUIRES an Encrypt Key and WeChat accepts
  safe mode only — without them the platform signs nothing that covers the
  body.
  **Reply tools are opt-in per connection** (`messengerConnections.replyTools`,
  `messenger/lib/reply-tools.ts`): the allowed groups come only from the
  owner's connection row, never from the inbound text; `ask`-mode tools are
  dropped (nobody can approve in a messenger); one `chargeRound` per tool reply,
  5 steps max; the 24h/48h reply window is re-checked after the tool run.
  **Media is fetched by the reply action, never the webhook** (`messenger/media.ts`;
  every download through `lib/media.ts#fetchMedia` — per-platform host allowlist,
  a bot token never follows a redirect off-host, 20 MB, MIME allowlist). A media
  message is also SAVED there, so it is absent from the thread until the action
  runs. The default chat model is text-only, so a thread whose recent rows carry
  image/file parts replies on `MESSENGER_MEDIA_MODEL`; audio reaches the model only
  as a transcript (`fileIds`, not a part — an audio part would fail most providers).
  Outbound media ships only when a reply's assistant rows carry file parts
  (`listReplyMedia`, owner-granted storage only) — so without reply tools
  (`tools: "none"`, the default) nothing ever attaches one.

- **Claim-once and crypto primitives** — `lib/claim-once.ts`
  (`idempotencyClaims`: messenger events, trigger webhooks, queue jobs) and
  `lib/crypto.ts` (`timingSafeEqual`, HMAC/digest helpers, the one
  `SIGNED_REQUEST_WINDOW_MS` for third-party webhooks). Do not add another
  dedupe table or another comparison loop.

- **In-thread branches** (regenerate / edit → "‹ 2/3 ›") — pure model and
  rules in `backend/lunora/agent/branch-tree.ts` (incl. `resolveBranchParent`,
  the one place `addMessagesHandler` decides a new row's explicit parent), the
  DB walk in `branch-rows.ts`, procedures and the path page in `branches.ts`.
  A row's parent is `parentMessageId`
  when set, else the PREVIOUS row by `(order, stepOrder)`, so pre-branching
  threads read as one line with no backfill. `threads.activeLeafMessageId`
  unset = never branched = every read stays on the old linear fast path; once
  set, message lists, agent context (`fetchRecentAndSearchMessages`) and forks
  (`cloneMessageBatch`) follow only the active path. Reads WALK it
  (storage-order range reads plus the `by_threadId_parentMessageId` index),
  costing about the page size; only a fork or a deleted leaf loads the whole
  tree (`buildBranchTree` — which must keep the walk's parent rule; the walk is
  what `branch-rows.test.ts` pins). A fork (`branchThread`) takes the clicked
  message's id and resolves it along the active path (`resolveForkEnd`), never
  a raw row index, which would count off-path siblings; with neither id nor
  index it forks the whole active path (the thread-level "Create branch"). The stored
  `threadRelationships.branchPoint` is a DISPLAY index on that path; readers
  cut through `getForkContextIds`, the same helper. That relies on
  `addMessagesHandler` advancing the stored leaf when a row lands directly
  under it — a writer that bypasses it (messenger's direct insert) leaves the
  leaf stale, which is still correct but costs a longer descent. Sibling replies to one prompt SHARE its `order` — so anything that
  groups rows by `order` alone (`toUIMessages`) must see path-filtered rows —
  including the public share view (`chat_sharing.getPublicThread`).
  Implicit parents make **position load-bearing**: a row inserted at the end
  of an earlier `order` would adopt the next turn as its child, so
  `addMessagesHandler` pins that next row's parent first. A tool-approval
  continuation takes an `order` past EVERY row (`continuationOrder`), not
  `prompt + 1`, which a sibling branch may already hold.

- **Spreadsheets / design canvas** — `"sheet"` artifacts store CSV in
  `documents.content` (Univer editor, code-split XLSX convert). `"design"`
  artifacts store Fabric.js JSON in `contentJson` and a PNG data URL preview in
  `content`. Both editors are code-split; keep them that way.

- **Pages** (`backend/lunora/pages/`, `apps/web/src/features/pages/`) — their
  own `pages` table, not `documents` (which requires a `threadId`). **Every
  content write goes through `functions.ts#writeContent`**: it re-anchors or
  orphans comment threads and records the version snapshot (one per author per
  10-minute window; agent edits and restores always get their own). A comment
  anchor is a `comment` mark with `commentId` — the server
  (`comment-anchors.ts`) and the editor (`lib/comment-mark.ts`) share that
  contract by name. A `comment`-permission user adds the anchor through
  `createPageComment`, which refuses any document that differs from the stored
  one in more than comment marks. As with threads, `isPublic` grants nothing:
  the public read is `pages_sharing.getPublicPage` by token, marks stripped.
  Saves are optimistic-concurrency: `revision` moves on every write,
  `contentRevision` only on real content changes, and a stale `baseRevision`
  is a CONFLICT (`data.code = PAGE_REVISION_CONFLICT`) only if content moved
  past it — comment activity alone never makes a collaborator's save stale.

- **Native shell** (`apps/native`, Tauri v2) loads the deployed app from a
  COMPILE-TIME `NEORE_SITE_URL` and grants IPC to that origin only, through a
  runtime `CapabilityBuilder` (four commands + event listen, plus on desktop the
  five `device_*` relay commands; no plugin command is reachable from the page). The web side is `apps/web/src/lib/native/bridge.ts`,
  a no-op outside the shell — call `notifyNative` from any long-running flow.
  **The web CSP deliberately does not allow `ipc:`**: Tauri falls back to
  `postMessage` IPC when the fetch is blocked, so do not "fix" the resulting
  one-per-page console warning by loosening `connect-src`. `tauri dev`/debug runs
  register `neore://` in `~/.local/share/applications` on Linux. Google sign-in
  goes through the system browser on the EXTENSION grant (redirect
  `neore://auth/callback`, opt-in in `TRUSTED_EXTENSION_REDIRECT_URIS`) and ends
  at `/api/auth/client-grant/cookie`, which sets the normal session cookie — do
  not add a second grant system. See its README.
  **Device execution** (`src-tauri/src/device/`, `backend/lunora/devices/`,
  `features/devices`, docs/plans/device-execution.md) is remote code execution
  on the user's machine, so the page is a RELAY only: the backend signs each
  call (HMAC, domain-prefixed payload STRING — no canonical JSON) with a
  per-device secret, Rust verifies signature/device/expiry/nonce, asks in the
  LOCAL `device` window (the only capability with the answer/settings
  commands) and signs the result, which `completeDeviceCall` verifies. Device
  tools exist only in interactive runs of a thread the user owns ALONE
  (`getDeviceToolContext`: no grant, not public/group/messenger) and are `off`
  headless whatever the mode. A call that follows untrusted content carries a
  server-computed, SIGNED `taintedBy` (`devices/lib/taint.ts`, fail-closed):
  it always prompts and never offers "Always allow"; `shell_run`/`fs_write`
  never do either. `shell_run` runs in an OS sandbox (`device/sandbox.rs`:
  Landlock / `sandbox-exec`; Windows has none) that writes only the shared
  folders + a per-run `$TMPDIR` and hides the rest of `$HOME` — network is NOT
  restricted, MCP servers are NOT sandboxed. Where there is no sandbox the call
  is REFUSED unless the user turned off "Require sandbox for shell commands"
  (stored inverted, `allowUnsandboxedShell`, so absent = required). Allow
  rules, shared folders, that setting and local MCP servers live only in Rust. **The pairing secret crosses the page exactly once**
  (`registerDevice` → `device_pair`), accepted because pairing needs a local
  click, a later page compromise cannot read it back, and a web revoke deletes
  the server copy; an asymmetric scheme was deferred to avoid new crypto
  crates. The HMAC vectors are pinned on BOTH sides — change one, update both.
  `tauri-plugin-dialog` is driven from Rust only; no window holds a dialog
  permission.
  **Chat status** comes from the device too: Rust emits a SIGNED
  `neore:device-progress` report (domain `progress`: `prompting` when the
  approval window shows the call, `running` before it runs) that the relay
  forwards to `reportDeviceCallProgress` — forward-only on a `claimed` call,
  display only, it can never finish one. The chat's device row
  (`features/devices/components/device-tool-call.tsx`, picked by the
  `device_<tag>__<tool>` runtime name, `@neore/chat-ui/utils/device-tool-name`)
  subscribes to `getDeviceCallByToolCall` ONLY while the tool part is in
  flight; a finished call reads its outcome from the tool output's `status`.

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
  OFF — its default is 10/day); the older `saasApiKeys` table is gone.
  `permissions` is server-only on `/api-key/create`, so scoped keys are minted by
  `auth_api_keys.createScopedApiKey`. `auth.api` is typed without plugin
  endpoints (`buildAuthOptions` returns plain `BetterAuthOptions`) — use
  `ApiKeyAuthApi` from `public-api/identity.ts`.

- **Storage access** — user files are PRIVATE. Server code reads them through
  `ctx.storage` (`lib/storage-read.ts`), never over HTTP; anything that must
  hand a URL out (download link, model provider fetching an attachment) gets a
  short-lived SIGNED URL from `ctx.storage.getSignedUrl`. Serving those is the
  APP's job — `lib/signed-storage.ts`, mounted as catch-all `GET /*` LAST in
  `http.ts` (keys contain slashes). `ctx.storage.getUrl` is an UNSIGNED URL
  nothing serves — do not use it. Needs `STORAGE_SIGNING_SECRET` (required
  outside development). **`verifySignedUrl`'s `expectedHost` wants a full
  ORIGIN** (`http://localhost:8788`) despite its name; a bare `host:port` fails
  every signature as `bad_signature`. There is NO public bucket
  (`R2_PUBLIC_URL_BASE` is gone): nothing persists a URL to our own storage.
  Messages store `storage:<key>` refs (`lib/storage-ref.ts`), re-signed on READ
  by `agent/stored-media.ts` — in the model context builder
  (`agent/client/search.ts`) and in the UI queries (`agent/display-media.ts`,
  bucketed expiry so a cached query result stays stable); vault rows sign their
  `key` on read (`vault/lib/display-url.ts`). A user message's media is only
  signed when its key belongs to one of that message's `fileIds`, and every
  client-supplied file id passes `agent_files.getFileForUser` (grant in
  `chatFileAccess`, or already attached in a thread the caller can read).
  **Bytes never ride in an RPC body** — Lunora caps a JSON RPC request at
  1 MiB (`413`). **Every upload goes over TUS to the upload route**
  (`lib/upload-route.ts`: `POST|PATCH|HEAD|DELETE /uploads[/:id]` for the
  session, `/api/v1/uploads` for API keys with `knowledge:write`) —
  `@lunora/storage/upload`'s `createUploadHandler` over
  `createR2BindingUploadStorage(env.FILES)`, no S3 credentials, the same under
  `lunora dev`. The web side is `apps/web/src/lib/upload/upload-file.ts`
  (`@lunora/client/upload`'s TUS adapter, 5 MiB chunks, progress; the bearer in
  the `Authorization` header, never the URL). The handler is built PER REQUEST
  for the resolved caller: the object key is `uploads/<userId>/<generatedId>`
  (never client-chosen — the codegen advisor ERRORs on a storage key taken
  from args), in-progress state lives under `upload-state/<userId>/` (another
  caller's upload id is a 404), a create declaring more than its declared
  type's chat cap (`uploadLimitFor`) or no size is a 413, a type off
  `UPLOAD_ALLOWED_MIME` a 415, each create is charged to `uploads/create`, and
  `GET` is a 405. That is only the client's DECLARATION: the finalize
  procedures take the staged object by `uploadId` alone, rebuild its key from
  the caller's identity and check the REAL bytes (`takeStagedUpload`: size cap,
  allowlist, leading bytes, then the staging object is deleted) —
  `file.finalizeChatUpload` dedupes into `agent-files/<sha256>`,
  `vault_functions.saveVaultFile` moves it to a server-minted key (5 MB cap),
  `chat_import_functions.startImportJob` hands the staging key to the import
  workflow, which deletes it when done. The route schedules a reap of each
  staging key an hour after its upload is created; the shard housekeeping sweep
  (`file.sweepStagedChatUploads`) is the backstop and also drops upload state
  untouched for an hour. There is no signed `PUT` path any more.

## INVITE-ONLY REGISTRATION

Sign-up requires an invitation; anonymous sign-in does not. `@lunora/auth`'s
`inviteOnly()` plugin plus the `signUpInvitation` table.

- **`SIGNUP_INVITE_ONLY` only turns it OFF** — `"false"` or `"0"`. Anything
  else, **including unset**, keeps it on. The failure direction of that flag is
  "anyone can register", so unset must not mean open.
- **Converting anonymous → real IS gated**, deliberately: better-auth creates a
  NEW user and links the anonymous one afterwards, so conversion is
  registration. Browse anonymously without an invitation; keep an account only
  with one. Social first-sign-in is gated for the same reason.
- **Anonymous sign-in is exempt upstream, and nothing of ours guards it.**
  `inviteOnly()`'s `user.create.before` exempts rows carrying `isAnonymous` when
  the `anonymous` plugin is installed. `invite-only.test.ts` drives the REAL
  plugin and asserts that exemption — if upstream ever drops it, that test is the
  only thing that notices.
- **The token reaches the browser only as `?invite=`**, read at submit time by
  `features/auth/lib/invite-token.ts` — not threaded through auth-card props,
  because the anonymous-conversion dialog needs it too and is not a child of that
  route. Never send it empty: the gate answers `SIGN_UP_INVITE_INVALID` for `""`,
  which reads worse than `SIGN_UP_INVITE_REQUIRED`.
- **Bootstrapping deadlocks without a seed** — `createInvitation` needs an admin,
  an admin needs an account, an account needs an invitation. Once after a
  deploy, run:

    ```bash
    curl -fsS -X POST "$BACKEND_PUBLIC_ORIGIN/admin/seed-invitations" \
         -H "Authorization: Bearer $LUNORA_ADMIN_TOKEN"
    ```

    It invites every address in `ADMIN` and returns
  `{ invitations: [{ email, status, signUpUrl? }] }`. **Idempotent:** a re-run
  mints nothing, reporting `pending` (unexpired link already out) or
  `registered` (spent), so it never kills a link you already sent. Only a
  missing or expired invitation is `issued` with a link; `?reissue=1` re-mints
  the pending ones when a link was lost. Bearer compared in constant time,
  rate-limited per IP BEFORE the check (`admin/seedInvitations`, 5 / 15 min),
  503 when `LUNORA_ADMIN_TOKEN` is unset — never open.
  (`auth/seed-invitations-http.ts`.) **`lunora run` cannot do this**: a
  client RPC to an internal function answers `FUNCTION_NOT_FOUND` whatever token
  it carries, which is why the route exists. `allowFirstUser` is upstream's
  alternative and deliberately NOT used — it races concurrent sign-ups and
  leaves the window between deploy and the owner signing up open. The e2e suite
  seeds through `POST /e2e/invitations` (`auth/e2e-seed-http.ts`,
  `apps/web/e2e/seed.ts`), which is 404 unless `ENVIRONMENT=development`,
  `PUBLIC_ORIGIN` is loopback AND `E2E_SEED_TOKEN` is set — that token lives only
  in `backend/.dev.vars` (dev-setup, CI), and the deploy binds none. It replaced
  writing the row into the local D1 file, which fought workerd for the lock
  ("database is locked" → 500). A backend started before the token was in
  `.dev.vars` answers 404 until restarted.
- The plaintext token is never stored (SHA-256 only), so a lost link is
  **reissued**, not recovered.
- Admin surface: `crpc.auth.invitations.*`, all `adminAction`. Nothing sends
  mail — `createInvitation` returns the URL and delivery is the operator's.

## ACCESSIBILITY

**Target: WCAG 2.1 AA.** `eslint-plugin-jsx-a11y` is active via
`@anolilab/eslint-config` — do not disable its rules.

- **Base UI foundation**: interactive primitives come from `@base-ui/react`,
  which handles ARIA roles, keyboard nav and focus trapping. Prefer them over
  custom implementations.
- **Semantic HTML first** — `<nav>`, `<main>`, `<button>`, `<a>` before `role=`.
- **Every control needs an accessible name.** Icon-only buttons always need
  `aria-label` or `sr-only` text.
- `<label>` must wrap its control or use `htmlFor`. For composite widgets
  (color pickers, file uploads) use `role="group"` + `aria-labelledby`.
- **Live regions**: streaming responses, loading states and toasts need
  `aria-live="polite"` or `role="status"`; urgent alerts `assertive`.
- **Hidden content** hidden by CSS also needs `aria-hidden="true"`, or screen
  readers navigate into it.
- Icons beside text get `aria-hidden="true"`; purely decorative images get
  `role="presentation"`.
- `packages/ui/src/global.css` has a global `prefers-reduced-motion` rule;
  Motion components must respect it too.

| Pattern               | Example                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Icon-only button      | `<Button aria-label="Close"><XIcon aria-hidden="true" /></Button>`                         |
| Streaming status      | `<span role="status" aria-live="polite">{statusText}</span>`                               |
| Composite field label | `<div role="group" aria-labelledby="label-id"><label id="label-id">Color</label>...</div>` |
| Hidden branch         | `<div aria-hidden={!isActive} className={isActive ? "block" : "hidden"}>`                  |

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

### Upstream: what is open, and what must not be re-filed

**Every defect from the migration audit is fixed or declined** — that batch is
closed out. One of ours is open: [#687](https://github.com/anolilab/lunora/issues/687)
(cloud spend cap prices 35 meters against one observed; non-blocking).
Fixed upstream and retired here: [#1052](https://github.com/anolilab/lunora/issues/1052)
(`cloudflareSend` needed a `SEND_EMAIL` binding), [#1054](https://github.com/anolilab/lunora/issues/1054)
(`lunorash` lagged its siblings; the single-copy errors/server/values overrides are gone),
[#1055](https://github.com/anolilab/lunora/issues/1055) (Creem dropped seat changes;
`billing/seats.ts` goes through `ctx.payments.adapter`), [#1060](https://github.com/anolilab/lunora/issues/1060)
(`lunora dev` dropped the preview `InternalApi` entrypoint), [#1037](https://github.com/anolilab/lunora/issues/1037)
(`lunoraTest` now takes `queues` / `notify`; `notifications/push.test.ts` still splices one
shared facade, since `lunora/notify.ts` makes a fresh memory store per ctx) and
[#1053](https://github.com/anolilab/lunora/issues/1053) (`stateScope` exists, but
`lib/upload-route.ts` builds per request anyway). [#690](https://github.com/anolilab/lunora/issues/690)
(schema check for `lunoraD1Adapter`; see the Auth notes), [#934](https://github.com/anolilab/lunora/issues/934)
(`lunora dev` ran a service's build in the app's cwd), [#810](https://github.com/anolilab/lunora/issues/810)
(codegen alpha.199–206 emitted `unknown` for every `Infer<v.object(...)>`
output; fixed in `@lunora/codegen@alpha.207`), [#797](https://github.com/anolilab/lunora/issues/797)
(`ctx.db.<table>` facades behind `rls()`; `restoreTableFacades` removed after a
runtime check on 8788, 2026-09-25), [#688](https://github.com/anolilab/lunora/issues/688)
(a bare `v.any()` arg is now emitted optional), [#689](https://github.com/anolilab/lunora/issues/689)
(the inspector pin moved to `lunora dev --inspector-port 9235`),
[#793](https://github.com/anolilab/lunora/issues/793) (SchedulerDO drains up to 6
due jobs at once since `@lunora/scheduler@alpha.79`, though it still never
defaults a job's `shardKey`), [#796](https://github.com/anolilab/lunora/issues/796)
(reconnect resubscribes are paced, but first-paint seeds are not, so
`MAX_CONCURRENT_SEEDS` stays), [#822](https://github.com/anolilab/lunora/issues/822)
(`rls()` dropped the SQL LIMIT on the legacy builder, so a guarded `take(5)` read
the whole index range; fixed in `@lunora/server@alpha.145`: measured 5 rows for
`take(5)`, 6 for `paginate(5)`. The ORM-facade reads and
`agent/admitted-thread-db.ts` stay, as ordinary code, not as a workaround) and
[#823](https://github.com/anolilab/lunora/issues/823) (codegen typed the
advisories as one array literal, and past ~1,150 findings `_generated/shard.ts`
failed with TS2590; since `@lunora/codegen@alpha.214` it emits `JSON.parse(...)`,
so the count no longer matters to `tsc`).

The launch work (2026-10) filed and saw fixed: [#951](https://github.com/anolilab/lunora/issues/951)
(codegen skipped writes in non-exported helpers), [#990](https://github.com/anolilab/lunora/issues/990)
(codegen read `*.test.ts`), [#991](https://github.com/anolilab/lunora/issues/991)
(`owner_field_from_args_not_auth` on a ternary's condition), [#996](https://github.com/anolilab/lunora/issues/996)
(error tracking: failed RPCs now carry code, name and stack; PostHog goes through
`webhookSink`), [#997](https://github.com/anolilab/lunora/issues/997)–[#999](https://github.com/anolilab/lunora/issues/999)
(Creem multi-reference customers, caller-aware `authorize`, lazy `ctx.payments`),
[#1021](https://github.com/anolilab/lunora/issues/1021) (`payment_*` table rename and
`paymentExtension`'s literal key) and [#1022](https://github.com/anolilab/lunora/issues/1022)
(`lunora dev` scaffolds only the imported payment adapter's secrets). The six
`owner_field_from_args_not_auth` ERRORs on guarded inserts are the equality-guard
shape #991 left open on purpose.

Moving queue, mail, push and uploads onto Lunora (2026-10) filed and saw fixed,
workarounds retired with `@lunora/cli@alpha.365`:
[#1033](https://github.com/anolilab/lunora/issues/1033) (`doctor` flagged the
optional vector metadata columns unfilterable: 20 false warnings),
[#1036](https://github.com/anolilab/lunora/issues/1036) (a `-preview` queue routed
to no handler — now aliased by the `env.preview` producers in `wrangler.jsonc`;
`Queues` is keyed by name; `maxConcurrency` exists but stays in
`lib/job-queue-config.ts` while `alchemy.run.ts` reads it there),
[#1038](https://github.com/anolilab/lunora/issues/1038) (lazy mail renderer and
transport, Message-ID on the sender's domain),
[#1039](https://github.com/anolilab/lunora/issues/1039) (`@lunora/errors` by range,
so `instanceof LunoraError` holds for notify's errors; per-message push urgency,
`high` again for approvals and questions) and
[#1040](https://github.com/anolilab/lunora/issues/1040) (typed upload provider
options; `authorize` may answer a `Response`, so a rate-limited create is a 429).
The same window shipped [#1030](https://github.com/anolilab/lunora/pull/1030):
`api.*` / `internal.*` nest by folder (`internal.lib.job_once.runJobOnce`), and
`internal` is imported from `_generated/internal`.

**A codegen regression can hide behind exit 0.** #810 turned 138 outputs into
`unknown` while codegen exited 0 and no advisory fired; only consumers'
`lint:types` showed it. After a codegen bump, compare
`cat backend/lunora/_generated/{api,internal}.ts | grep -c "unknown>"` with the
previous count (35 on codegen 214, 235, 246 and 279 — the GDPR export
collectors' untyped arrays; 31 on 207, against 157 on 205). Run codegen twice
after a change that renames references: inference reads the source, and a
reference codegen cannot resolve yet types its caller's output `unknown`. When probing
generated output, run `tsc` per project: `vis run lint:types` re-runs the
backend's `codegen` target first and silently overwrites any `_generated/`
you are testing. **Build the packages first in a fresh checkout or worktree**
(`pnpm build:packages`): `packages/*/dist` is git-ignored, and without it a
return type imported from `@neore/service-sdk` degrades to `unknown` (36, not
35) with codegen still exiting 0.

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
Before, `queryCoordinator` pointed `createDynamicShardRegistry` at `env.SHARD`
and no shard ever registered there. A shard written before the registry was
bound is listed only after its next write (no data exists yet).

|                                                       |                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [#687](https://github.com/anolilab/lunora/issues/687) | Cloud prices 35 meters against one observed.                                                                                |
| [#360](https://github.com/anolilab/lunora/issues/360) | Pluggable queue drivers; feature request, closed as not planned.                                                            |

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

### Codegen

```bash
cd backend && pnpm codegen     # lunora codegen, then backend/scripts/check-generated.mjs
```

- **`_generated/` is not ours to edit.** `check-generated.mjs` patches nothing —
  it is a regression check for a `.pnpm` store-path import codegen once emitted
  (which came back once after an unrelated change). If generated output does not
  compile, the fix goes in a `.d.ts`, in our own source, or upstream.
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
  `pnpm --filter @neore/backend run advise`; it scores 692 procedures and takes
  `--baseline` for regression gating.

### Modules

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
- **GDPR's findings are accepted** (325 on 2026-10-06; codegen counts the
  shared `deleteQuietly` helper once per caller) — erasure (`gdpr/steps/*`) must reach
  every table, and its batching/ordering is pinned by the tests beside it; see
  `gdpr/module.ts`. A NEW module puts its erasure in `<module>/gdpr.ts` (as
  devices, evals, pages, tasks … do), wired into the deletion workflow, so it
  draws none. Any `cross_module_table_write` outside `gdpr/steps/` is a
  regression.
- **Architecture view**: codegen writes `_generated/architecture.{json,ts}`
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

### Reading advisories

The tree draws **6 ERROR, 425 WARN, 668 INFO** (2026-10-06) — 100 WARN plus the
325 accepted GDPR `cross_module_table_write` findings. The 6 ERRORs are
`owner_field_from_args_not_auth` on guarded inserts the lint cannot see through:
platform-admin `setMemberCreditOverride`, org-admin `addMember`/`addTeamMember`
(they add ANOTHER user), and the active-org equality checks in
`createPrompt`/`createSkill`. Advisories never fail codegen; test files
(`*.test.ts`, `__tests__/`, …) are not analysed. **Piping codegen's output truncates that list** at wildly
different points (one run printed 88 and looked like the whole set), so redirect
to a file and count there:

```bash
cd backend && ./node_modules/.bin/lunora codegen > /tmp/cg.log 2>&1
sed -i 's/\x1b\[[0-9;]*m//g' /tmp/cg.log
grep -oP "\[(ERROR|WARN|INFO)\] \K[a-z_]+(?= —)" /tmp/cg.log | sort | uniq -c | sort -rn
```

Most of it is noise by design (`procedure_without_structured_event` 289,
`nondeterministic_query_mutation` 293).

`unbounded_string_arg` (was 418, now 26) is purely SYNTACTIC: it flags an
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
  four surfaced three real bugs the empty argument type had hidden (commit
  `c8337ff9`); the worst was `streamingMessages.stateKind` being written by
  nothing while three index reads depended on it.

### Validators: `v` vs zod

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

### Duplicate `@lunora/*` copies

**All 34 `@lunora/*` packages plus `lunorash` resolve to ONE version each**,
`@lunora/errors` included (2026-10-02, cli alpha.333 / lunorash alpha.335 —
every meta-package pin matched the `alpha` dist-tag that day). That is not the
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

The one override that stays is `"@lunora/auth@*"` in `pnpm-workspace.yaml`. It
collapses nothing today — keep it because better-auth's `User`/`Session` are
branded and do cross into our handlers, so if any release starts peer-depending
on auth at a different range, this is what stops the split surfacing as an
inscrutable "separate declarations of a private property".

Two traps when investigating:

- **Resolution is per-file-location, not per-project.** `apps/web` compiles
  `backend/lunora/_generated/api.ts` as source, and that file's `lunorash/*`
  imports resolve from `backend/node_modules`, which `apps/web` has no path to.
  A probe file dropped in `apps/web/src/` fails with TS2307 and proves nothing.
- **A version present in `node_modules/.pnpm` is not necessarily resolved.** pnpm
  does not prune the store on downgrade. The lockfile is the authority; confirm
  with `find node_modules -maxdepth 5 -type l -lname '*<pkg>@<version>*'`.

## RUNTIME LESSONS (D1 vs DO)

`tsc` clean is not "works". Every item below typechecked fine and failed on the
first real request. They were found by driving the app in a browser
(`apps/web/e2e/auth-flow.mjs`, `apps/web/e2e/authed-chat.mjs`, against a live
`dev:backend` + `dev:app`).

### Database access

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
  The Worker's own sweep (`auth/lib/ensure-global-tables.ts`, ~350 sequential
  statements even when every table exists) is skipped once `globalSchemaMarker`
  holds the schema's fingerprint, so a schema change is picked up by the next
  cold isolate; drop that row if you drop a table by hand. The ShardDO's lazy
  sweep inside Lunora still runs once per DO isolate.
- **`lunora build` runs a schema-drift gate**, separate from the advisor. It
  diffs `schema.ts` against the committed baseline
  `backend/lunora/.lunora-schema.json` and exits 1 on a breaking change with no
  migration — so a field rename fails the build long after working fine in dev,
  because dev never consults the baseline. `lunora prepare
--update-schema-baseline` is the escape hatch for "you know data is compatible";
  `--allow-schema-drift` skips the gate for one run WITHOUT advancing the
  baseline. Once there is data at rest, use the widen → migrate → narrow path
  from the `lunora-migration-helper` skill instead.
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

### Sharding and concurrency

- **Per-user sharding: a row lives on the shard of the user who OWNS the
  object it belongs to** (docs/plans/per-user-sharding.md). `ctx.db` never
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
  (`providerMetadata.neoreJob`), so the user can retry. A redelivered run is dropped, not
  resumed: a run killed mid-way leaves its stream for the timeout cron.
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
  dev. It is keyed on the D1 binding object: anything that hands `.global({ d1 })`
  a fresh wrapper per request re-runs it on every request (a timing proxy once
  did, costing ~3s per read). The old note here ("~1s per request, miniflare's
  loopback") was a misreading of this.
- **An un-hinted `ctx.db.get(id)` of a `.global()` row probes EVERY global
  table** in one batched D1 round trip (41 tables), because the id is not in
  the shard's local table set — ~70-125ms locally each time, three of them made
  a warm `getUserSettings` 0.4-0.5s (7-15ms after the fix). Read a global row
  by id with `ctx.db.<table>.findFirst({ where: { _id } })` — ONE statement.
  Neither `ctx.db.asId(table, id)` nor the facade's own `ctx.db.<table>.get(id)`
  avoids the probe (measured). `lib/global-get.guard.test.ts` fails on a new one.
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

### Auth

- **`authorizeShard` must compare, not pattern-match**
  (`src/shard-routing.ts#createShardAuthorizer`). A shard key is `__root__`
  (open) or a user id, admitted for that user and for anyone they granted a
  thread or page — a `.global()` grant row with `ownerId` = that shard, read raw
  from D1 and cached 30s per isolate (so a revoked grant passes the SHARD gate
  that long; the procedure re-reads the grant). A prefix heuristic like
  `!shardKey.startsWith("user_")` never fires — better-auth ids carry no prefix —
  and silently allows cross-user Durable Object access. An anonymous caller is
  never admitted to a user shard; public views cross over server-side.
- **The bearer path needs its own verification.** The browser client
  authenticates with the JWT from `/api/auth/token`; `getSession()` does not read
  it, so `resolveIdentity` verifies it against our JWKS with `jose`. Decoding
  without verifying would let any caller assert any `sub`.
- **The live-query socket never carries the JWT.** Workers observability logs
  every request URL, and a browser `WebSocket` can only send its credential in
  the URL. So the web client POSTs its bearer to `/_lunora/ws-ticket` before
  each (re)connect and the socket sends the returned single-use, 30s ticket
  (`lib/ws-ticket.ts`, a raw `wsTicket` D1 table redeemed with
  `DELETE … RETURNING`, created lazily per isolate, purged on every mint and
  on the Worker's `scheduled()` tick). It rides as `?token=` only because that is the one
  name `LunoraClient`'s `wsToken` provider appends; `requestBearer` reads the
  `Authorization` header alone, and `?token=` is only ever redeemed as a ticket.
- **The backend mints JWTs with whatever host it is reached on, not `SITE_URL`.**
  `@lunora/auth` resolves the base URL per request and the app's auth proxy
  rewrites the Host header, so a token minted through `/api/auth/token` on the
  APP origin still comes back with `iss = aud =` the backend origin. The
  consequence is a config coupling with no compile-time or runtime check:
  **`VITE_LUNORA_URL` must equal the backend's `PUBLIC_ORIGIN`**, because
  `server.ts` pins `jwtVerify` to it. If they drift, every bearer token verifies
  as anonymous and the app looks signed-out with no error. The deploy job feeds
  both from one secret — do not split them.
- **`<Unauthenticated>` means "no token", not "no session".** The RPC token is
  fetched after the session cookie lands, so a just-signed-in user reads as
  logged-out for a window. Two bugs lived in that gap (auto guest sign-in minting
  a guest over a real session; nothing ever fetching a token for an existing
  session). Both are fixed at the source — never widen a gate to paper over it.
- **A FAILED session read is "unknown", never "signed out".** better-auth
  rate-limits `/api/auth/*` per client IP + path (100 per window, 3 for
  sign-in/up), and its window only resets after a 10 s QUIET gap — sustained
  traffic from one office NAT never gets one. Lunora's identity probe read a
  429 as "nobody" (hiding `<Authenticated>`), and a 429 on `/api/auth/token`
  made the root route redirect to sign-in. Now: `get-session` is exempt
  (`AUTH_RATE_LIMIT_CUSTOM_RULES`, `auth.rate-limit.test.ts`); session reads
  retry through `apps/web/src/lib/auth/session-read.ts` (the probe THROWS when
  exhausted, which Lunora settles as `unreachable` — gate open); the root route
  carries `authStatus`, and guards use `requireSession` (`lib/auth/route-guard.ts`),
  which redirects only on an ANSWERED "no session". A new guard must use it.
- **The browser reads the session ONCE per page load.** Three readers each
  made their own `GET get-session` — better-auth's session atom
  (`authClient.useSession`), the TanStack `["session"]` query
  (`features/auth/hooks/session-user-management.ts`) and Lunora's identity
  probe (`getCurrentUser`, to the BACKEND origin). Both clients' `fetch` now
  answer a plain session read from one shared read on the app origin
  (`lib/auth/shared-session.ts`, `createSharedSessionRead`): joined while in
  flight, reused 10 s, never cached when it failed. Any auth request that may
  change the session (`isSessionChangingRequest`: every non-GET except
  `has-permission`/`check-slug`, plus the verify GETs) drops it when it starts
  and ends, and so does better-auth's cross-tab `storage` broadcast — whose
  listener must stay registered BEFORE better-auth's (client.ts creates it at
  module load). A new way of changing the session outside `authClient` must
  call `getSharedSessionRead()?.invalidate()`. Browser only: on the server the
  module is shared across requests. `session-single-read.test.ts` counts.
- **Our better-auth tables in `schema.ts` are hand-maintained copies, and a
  better-auth bump can break every auth request.** Since 1.7.3 (upstream #690)
  `lunoraD1Adapter` introspects D1 at init and throws `SchemaMismatchError` on a
  missing column OR a required column better-auth never writes — `/api/health`
  500s. `lunora/auth.schema.test.ts` runs the same rules against `schema.ts` for
  the plugins `buildAuthOptions` installs; run it after any better-auth bump.
  Two traps when fixing: a new column that is required fails the build's drift
  gate (declare it optional; better-auth writes it anyway), and the local D1 keeps
  its old columns — `.global()` tables are created lazily but never ALTERed, so
  add the column with `sqlite3` on `backend/.wrangler/state/v3/d1/…` and touch a
  source file (the adapter caches a failed check per isolate).
- **A store-level workaround is removable only if a WRITE proves it.** A read
  does not: `get-session` answered 200 with and without the `_creationTime`
  decorator, because the rate-limit row already existed and the write was an
  `UPDATE`. Only a fresh `INSERT` fails.
- **Row-level security is defence in depth UNDER each procedure's check**
  (`backend/lunora/lib/rls/`). Every client-reachable builder in `lib/crpc.ts` —
  the bare `query`/`mutation` the `agent/*` files use included — ends in
  `withRlsScope` + `rls(POLICIES)`, after its auth
  middleware. Policies say "is this caller connected to this row AT ALL" (owner,
  or a thread/page/org the request proved); WHICH permission a grant carries
  stays the procedure's job. Internal functions (scheduler, queue, crons,
  workflows) are built without it and see every row; `admin*` builders open an
  admin scope that every policy allows. Actions are unguarded — no action may
  touch `ctx.db` (`rls.guard.test.ts` pins it). The schema is NOT
  `.rls("required")`: that mode guards internal functions too, and would fail
  closed on all of them. Non-obvious rules:
    - **Sharing works by ADMISSION.** Policies are synchronous and memoized per
      table per request, so they cannot look a grant up. The access helpers
      (`resolveThreadReadAccess`, `requireOwnedThread`, `resolvePageAccess`,
      `requireOwnedPage`, `admitOwnedThread` after an ad-hoc owner check, the
      share-token reads, org membership checks) decide past RLS through
      `systemDb(ctx)` and then `admit*` the resource into `ctx.rlsScope`. Read
      predicates close over the scope's ARRAYS by identity, so a row admitted
      after the predicate was built still matches. A new sharing path must
      admit, or its reads come back empty.
    - **"Load a child by id, then check its parent" returns `null` now** — the
      child is invisible until the parent is admitted. Use
      `parentKeyOf(ctx, id, "threadId")`, decide on the parent, then read the
      row through `ctx.db`. Likewise, run the access check BEFORE a parallel
      read that depends on it (`getThreadAccess` used to `Promise.all` them).
    - **`systemDb`/`parentKeyOf` bypass RLS** and every importing file is listed
      in `rls.guard.test.ts` — use them for DECISIONS (existence, ownership of a
      storage key, uniqueness, a count of the caller's own rows), never to hand
      rows to a caller who was not proven to reach them.
    - **`count()` throws behind a read policy** (`COUNT_RLS_UNSUPPORTED`), even
      with a `where` equal to the policy. Own-row counts go through `systemDb`.
    - **A table with any policy denies every write op it has no policy for**, so
      `policiesFor` always declares read/insert/update/delete. `update` is checked
      on the row before AND after the patch.
    - **`ctx.db.<table>` behind `rls()` is the GUARDED facade**: the wrapper
      re-binds the facades the runtime sets on `ctx.db` over the policy writer
      (checked at runtime: present, and a stranger's `findFirst`/`get`/`findMany`
      return nothing). A test ctx without them (`lunoraTest` before
      `test/setup-harness.ts` binds them) has none behind `rls()` either — that
      is what #797 reported; do not re-add a workaround.
    - **An un-hinted `ctx.db.get(id)` of a `.global()` row is expensive behind
      RLS**: the wrapper cannot tell the table from the id, so it probes EVERY
      policed table (`findFirst` each, in parallel). Shard rows short-circuit
      through `lookupById`; global rows do not. Read global rows through the
      table facade — `ctx.db.user.get(id)` — which passes the table.
    - **RLS layers AND together**, so an admin builder derived from a guarded
      user builder could never widen — each builder chain is spelled out from the
      generated builder.
    - Every schema table is either policed or listed in `UNPOLICED_TABLES` with
      its reason (better-auth/org tables, content-addressed `chatFiles`,
      owner-less child rows reached only through a checked parent, counters).
      A new table must be decided there, or the guard fails.
- **Every client-reachable procedure has a reviewed row in
  `docs/security/authz-matrix.md`**, and `lunora/authz-matrix.guard.test.ts`
  fails when `_generated/api.ts` gains or loses one without the matrix
  following — so a new procedure means checking its ownership rule and adding a
  row. A procedure built WITHOUT auth middleware (bare `query`/`mutation`/`action`,
  `public*`, `optionalAuth*`) must also be named in that test's allowlist. The
  recurring hole shapes were an id from args read with no owner comparison, an
  `organizationId` from args (use `assertOwnOrganizationId`), and a relationship
  or link row treated as a read grant on the thread it names.
- **Organization membership grants nothing by itself** — not on threads, not on
  vault files (owner, or a grant on the file's chat). Org-scoped features share
  explicitly (prompts' `organizationId`, org skills). **Billing tier and credit
  allowances are platform-admin only** (`auth_billing.setOrganizationBillingTier`,
  `setMemberCreditOverride`): billing runs in a separate system, and any user can
  create an org and own it.

### Local dev

- **Mail never leaves the machine in `lunora dev`.** `@lunora/mail`
  (`backend/lunora/email/mailer.ts`) captures every send into the studio's
  **Mail** tab — verification links, resets, OTPs, invites. Capture keys off
  `ENVIRONMENT=development` / lunora dev's `WORKER_ENV`, not off a missing
  provider, and needs `MAIL_FROM` (dev-setup writes it) plus the
  `LUNORA_ADMIN_TOKEN` lunora dev generates. Sends ride the jobs queue, so a
  mail shows up after the queue's ~1s batch window. `LUNORA_MAIL_CAPTURE=0`
  delivers for real (set `RESEND_API_KEY`).
- **Check the host firewall FIRST when local requests are slow or dropped.**
  On a machine running OpenSnitch, a `workerd` binary without an "allow
  always" rule gets its LOOPBACK connects held or denied. That is every call a
  worker makes to another local worker or to itself: the gateway, the
  scheduler/queue self-dispatch, `/chat/chunks`. It shows up as multi-second
  idle waits and bursts of "Network connection lost.", and it looks exactly like
  an app regression. Measured 2026-09-25: 12% of backend requests lost and a
  20s self-dispatch p50 while the other side logged 13ms and every process was
  idle. After approving the binary: 1.2% and 0.7s. Every wrangler/workerd bump
  ships a new binary path that needs its own rule. `/var/log/opensnitchd.log`
  shows deny rules being added, and `/etc/opensnitchd/rules` should hold an
  allow-always file for the current `workerd-linux-64@<version>`.
- **`wrangler dev` dies with `Network connection lost.`** — miniflare's loopback
  raises it and wrangler escalates it to a fatal process exit, taking the backend
  with it. The app then 500s on SSR purely because the backend is gone, so
  **check `curl localhost:8788/api/health` (or `ss -lntH | grep 8788`) before
  reading any application code.** Two triggers, both ours to avoid:

    1. **An unconsumed response body on a failed outbound fetch.** A Worker must
       consume or cancel every body it opens; a `!response.ok` early-return that
       touches neither is the shape to grep for. Adding
       `await response.body?.cancel()` took 43 forced 403s from 4 fatal exits to 0.
       Every such branch in `backend/lunora` and `llm-gateway` now cancels —
       including the quiet ones: an `if (response.ok)` fall-through, and
       fire-and-forget POSTs whose reply nobody reads. **In the backend, do not
       hand-write that branch when it just throws:** `assertOk(response, "X API
error")` (any transport, including the SSRF-guarded tool
       `fetchWithTimeout`) or `fetchOk(url, { errorPrefix })` from
       `lib/fetch-timeout.ts` cancel the body and throw `HttpError` with the same
       `"<prefix>: <status> <statusText>"` message (`includeBody` keeps a
       truncated body on `.body` instead). Hand-written branches remain only
       where a failure returns a fallback rather than throwing.
    2. **Concurrency on the `__root__` shard** (see above). Deterministic repro:

        ```bash
        for i in $(seq 1 10); do curl -s -o /dev/null -X POST localhost:8788/_lunora/rpc \
          -H 'content-type: application/json' \
          -d '{"functionPath":"changelog_functions:getChangelogs","args":{}}' & done; wait
        curl -s -o /dev/null -w '%{http_code}\n' localhost:8788/api/health   # 000
        ```

    Wrangler escalating a recoverable blip to process exit is still an upstream
    defect, **fixed upstream in wrangler 4.129.1**: from there "Error inside
    ProxyWorker" fails only the affected request and the dev server continues
    (4.127.1, tried earlier, predates the fix). The catalog is on wrangler
    4.145.0 + `@cloudflare/vite-plugin` 1.62.3 (workerd 1.20260930.2) (they move together — each
    plugin release peer-requires its wrangler). **Every such bump ships a new
    workerd binary**: on a machine with a per-app firewall (OpenSnitch) an
    unapproved workerd has every `connect()` time out — even to loopback — and
    the whole stack is down until the binary is allowed. The rule is keyed on
    the binary's FULL PATH, so a git worktree's `node_modules/.pnpm/...workerd`
    needs its own rule even when the main checkout's is allowed; the symptom is
    `Ready on http://localhost:8788` in `dev.log` while even `/_lunora/status`
    hangs. Verified after the
    4.141 bump: the 10-concurrent repro below with 300ms client aborts ×3, and 10
    browser contexts closed mid-first-paint, killed the backend 0 times (the
    same close killed 4.124 2 times in 6).
    The failure is INTERMITTENT, so a clean run proves nothing — judge over
    several. When `pnpm test:e2e` shows a run of `TypeError: fetch failed`,
    check whether the backend is still up before debugging them as test defects.
    **`scripts/dev-backend-watchdog.sh`** restarts the backend when its worker
    process is gone and archives the dying run's `dev.log` (which a restart
    truncates) to `backend/.lunora/crashes/`; CI's e2e job runs the backend
    under it. **The mechanism, reproduced:** a client that ABANDONS a request
    the backend has already accepted — a timeout, a closed tab, a navigation —
    leaves a reply to be written to a closed socket, and that write is the
    "Network connection lost." (closing a context mid-first-paint took the
    backend down 2 times in 6). So anything that aborts requests to 8788 is a
    trigger, and three were ours, now removed: `lunora dev`'s readiness probe
    (1s timeout, every 250ms) against a `/_lunora/status` that waited behind
    `ensureGlobalTables` — now answered first thing in `src/server.ts`, which
    also ended the restart-into-crash-loop; the gateway's `/chat/chunks` poll
    carrying the BROWSER's abort signal (`client-stream.ts`); and bearer
    verification fetching the Worker's OWN `/api/auth/jwks` over loopback with
    jose's 5s timeout — now read in-process. Probe with LONG timeouts; the e2e
    fixtures wait for in-flight backend requests before navigating or closing a
    page (`trackBackendRequests` in `apps/web/e2e/chat-helpers.ts`). On 4.124
    those removals alone did not move the rate (~3 crashes per 100 non-health
    requests, several agents browsing): any browser navigating away from a slow
    first paint is the same trigger — only the wrangler fix removed it. `WATCHDOG_RUNNER=wrangler` runs the worker
    without `lunora dev`'s supervisor (no readiness probe, no `dev.log`).

- **Port 8788 belongs to the backend** — and to the services it binds, which
  run INSIDE its `lunora dev` session with no port of their own. The standalone
  ports — 8787 (llm-gateway, the browser's public gateway, started by `pnpm
  dev`), 8789 (browser-renderer), 8790 (embeddings), 8791 (nsfw-checker), 8792
  (document-parser) — matter only when a service runs ALONE (`pnpm
  dev:<service>`, spec extraction). The gap at 8788 is deliberate, because
  `backend/.dev.vars` pins `PUBLIC_ORIGIN=http://localhost:8788` (written by
  `scripts/dev-setup.js`; it cannot live in `wrangler.jsonc`, where
  `lunora build` blocks on any loopback address) and
  `backend/project.json` passes `--worker-port 8788`. **A new service takes the
  next free port after 8792 and must never take 8788.** The tell that something
  else grabbed it is a 404 on `/_lunora/status` in that service's log — the
  Lunora supervisor probing 8788 and being answered by the wrong worker.
- **There is a SECOND port map — the wrangler inspectors.** Each service pins one
  in its `package.json` dev script for standalone runs: 9230 (llm-gateway),
  9231 (document-parser), 9232 (browser-renderer), 9233 (embeddings), 9234
  (nsfw-checker); the backend session (with its in-session services) pins
  **9235** with `lunora dev --inspector-port 9235`, in `project.json`'s dev
  target, `package.json`'s `dev` script and `scripts/dev-backend-watchdog.sh`.
  Any new way of starting it must pass the flag too. That pin matters because
  without it the backend
  takes wrangler's default 9229 and, finding it busy, walks UPWARD into the
  services' range (the standalone gateway holds 9230 in every `pnpm dev`). Two things make this expensive: the error names a port in no
  service map, and _which_ worker dies is non-deterministic. If a worker reports
  `Address already in use` on a 92xx port, run `ss -lntp | grep 92` before
  reading any config — a leftover stack produces the identical error.
- **Every `dev` target needs an explicit `"command"` in its `project.json`**
  (vis 4.0.1). Without a TTY (an agent, CI, a pipe), `vis run dev` runs
  persistent tasks AFTER the graph from each target's `command` only — a target
  that falls through to the `package.json` script is dropped without a word.
  That run also prints `N tasks skipped (dependency failed or --bail)` for
  tasks it is about to start, and discards their output (and a failing one
  kills the others). So in a non-TTY shell `pnpm dev:chat` LOOKS like it
  started nothing even when it did: check `ss -lntH` for the ports, not vis's
  summary, and read logs from the TUI (`script -qec "pnpm dev:chat"`) or from
  per-project `pnpm --filter <name> dev`. The TUI path resolves the script
  itself, which is why this hides at a terminal.
- **Tearing the stack down takes two steps.** The backend is a **managed daemon**
  that is re-parented to init, so killing the `pnpm dev` root does not cover it:
  `cd backend && ./node_modules/.bin/lunora dev stop`, plus `kill` for the rest.
  **`npx lunora` does not work** — there is no `lunora` package on npm (the CLI
  ships as `@lunora/cli`) and the binary is not hoisted to the root
  `node_modules/.bin`. Orphaned workerd processes leak across days (one held
  775 MB two days on); they bind random high ports, so they cost memory rather
  than collisions.
- **The backend logs to `backend/.lunora/dev.log`, not the shell.** Read it with
  `cd backend && ./node_modules/.bin/lunora dev logs`. Editing
  `backend/wrangler.jsonc` does NOT hot-reload (source files do), so an env var
  added there for a probe silently keeps its old value.
- **Renaming or deleting an exported procedure kills a running backend.** The
  source save hot-reloads before codegen rewrites `_generated/functions.ts`,
  which still imports the old name: `Cannot read properties of undefined
  (reading 'args')` at startup, and wrangler exits for good. Add the new export
  first, run codegen, then remove the old one — or restart the backend after.
- **`wrangler dev` needs `--local` for the gateway.** From wrangler 4.122 the
  Workers AI binding is proxied to the real network by default, so plain
  `wrangler dev` opens a remote proxy session and dies demanding a
  `CLOUDFLARE_API_TOKEN` in any non-interactive shell. `services/llm-gateway`'s
  `dev` script passes `-l`.
- **`scripts/dev-setup.js` is the only thing that writes `apps/web/.env`, and it
  must cover every REQUIRED var in `apps/web/src/lib/env.ts`.**
  `VITE_LUNORA_URL`, `VITE_SITE_URL` and `VITE_LLM_GATEWAY_URL` are bare
  `z.url()` — not optional — so a missing one is a hard boot failure, not a
  degraded mode. `VITE_LUNORA_URL` is force-_aligned_ rather than defaulted,
  because a stale value is worse than a missing one (see the JWT note above).
  **If you add a required `VITE_` var to `env.ts`, add it to step 5 of that
  script in the same commit.**
- **A dependency change means clearing `apps/web/node_modules/.vite`.** Vite's
  optimiser otherwise wedges on "bundling dependencies..." indefinitely — port
  open, never serving. Cold start after clearing is ~16s.
- **Never set `server.warmup.clientFiles`.** It deadlocks the client dep
  optimizer and reproduces on a clean cache every time: a warmup transform parks
  on the optimizer, which only commits once the static-import crawl goes idle,
  which cannot happen while that transform is parked. **ONE entry is enough**;
  `ssrFiles` is safe. Removing warmup also made the client scan 13× faster and
  the bundle 2.3× faster, so it cost what it claimed to save. Telling it apart
  from the stale-cache wedge: `.vite/` holds `deps_temp_*` with **no
  `_metadata.json`** and no `deps/`, and
  `curl localhost:5173/node_modules/.vite/deps/react.js` hangs rather than 404s.
  **SSR is unaffected, so the failure is invisible server-side** — `/` returns
  200 with complete markup while the browser is dead. Never take SSR markup, or a
  200 from `curl /`, as evidence that the app hydrates.
- **`pnpm lint:types` can fail spuriously right after a dependency change** —
  `@neore/ai` rebuilds `dist/` while consumers typecheck against it
  (`TS6053: File 'packages/ai/dist/*.d.ts' not found`). Re-run once the build
  lands before believing it.

### Frontend

- **`crpc.X.queryOptions()` is LIVE by default**.
  `lib/lunora/live-queries.ts` watches the TanStack cache: an active Lunora key
  opens a WebSocket subscription whose pushes `setQueryData`, and it
  unsubscribes 10s after its last observer leaves. The queryFn answers from the
  subscription, so a live query costs one execution on first paint rather than
  RPC + seed. SSR still fetches once, and the browser subscribes after hydrate.
  `skipToken`/`enabled: false` never subscribe. Opt out per call with
  `queryOptions(args, { live: false })`, or for everyone with `NEVER_LIVE` in
  `crpc.tsx`. Opt out for per-keystroke searches, heavy aggregates, and data a
  Lunora hook already subscribes to (`useUIMessages`). Five things to know:
    - **The subscription's args come from `meta.lunoraArgs`, never the key.**
      Since `@lunora/react@alpha.166` a query key's args slot is the
      wire-encoded STRING, not the object; subscribing with it sent every
      procedure a string, so each required arg read `undefined` (streams never
      settled, first paint fell back to RPC). `crpc`'s live `queryOptions` sets
      the meta; `live-queries.ts#argsOf` reads it (an observer's, after a
      hydrate). A hand-built live key needs the same meta.
    - **Every live query re-runs on its shard** (the caller's, or a shared
      object's owner's — the client opens one socket per shard) whenever a
      write touches a table (index range) it read. Measured `/chat` first paint: 7
      live subscriptions (11 before `NEVER_LIVE`), `/tasks` 5. The cap is 32 per
      socket (`TOO_MANY_SUBSCRIPTIONS`), and a query that hits it quietly falls
      back to one-shot.
    - **Seeds are throttled to 3 in flight** (`MAX_CONCURRENT_SEEDS`). Eleven at
      once reproduced local dev's fatal `Network connection lost.` in 2 of 7
      runs; three at a time, 0 of 4, and no slower (~4s cold, 0.2–0.5s per seed
      warm). Upstream #796 (`@lunora/client@alpha.126`) now paces RECONNECT and
      tab-leader resubscribes to 3 in flight, but not these first-paint seeds,
      so this throttle is still needed.
    - **The socket authenticates with a single-use ticket, not the JWT** (see
      the Auth notes and `lib/lunora/ws-ticket.ts`). `setAuthToken` never
      re-authenticates an open socket, so the manager bounces it when the
      token's SUBJECT changes, not on a same-user refresh.
    - **Manual `invalidateQueries` after a mutation is now a fallback.** While a
      subscription is open it is answered from it without an RPC. It is
      harmless, so it was left in place.
- **E2E against the mock model.** `MOCK_LLM=1` in `services/llm-gateway/.dev.vars`
  swaps every model for `providers/mock-model.ts` (refused when NODE_ENV or
  ENVIRONMENT is production): replies are `Mock reply: <prompt>`,
  `[[reasoning]]` adds reasoning, `[[tool:<name> <json>]]` calls a tool once, and
  schema/"Respond with ONLY a JSON object" calls get minimal valid JSON with
  booleans `true`. On a machine with a per-app firewall (OpenSnitch) a freshly
  downloaded Playwright Chromium has its SYNs dropped even to loopback — every
  `goto` times out while curl works — until it is allowed;
  `E2E_BROWSER_CHANNEL=chrome` runs the installed Chrome meanwhile.

- **A form can be visible before it is interactive.** The auth pages are
  server-rendered, so inputs paint — and Playwright sees them — before React has
  attached the submit handler. **`toBeEnabled()` does not close this window**; it
  is a rendering check and the SSR'd button is already enabled. Use
  `awaitFormHydrated()` from `e2e/helpers.ts`, which waits for `form[novalidate]`
  — the forms set `noValidate={isHydrated}`, so that attribute cannot appear in
  SSR markup and is therefore a signal the CLIENT owns. A click inside the window
  does nothing at all: no request, and the browser falls back to a native GET
  that shows up as a navigation to `/auth/sign-up?`. It reads exactly like a form
  that refuses to submit — and an unreachable backend produces the same symptom
  for a different reason, so check both.
- **`react-doctor` reports React Compiler bail-outs that do not happen in the
  build.** It runs the compiler over RAW source without this app's babel plugins.
  The Lingui macro is one of those, so every `` t`...${x}...` `` reads as an
  unlowerable tagged template — 186 of 243 such findings, ~37% of its error
  count. **Do not "fix" these**, and in particular do not split the babel passes
  in `vite.config.ts` to chase them: the passes are already correct, and
  rewriting `t` templates by hand changes extracted message IDs and breaks the
  translation catalogs.
- **A `todo` finding means the compiler bailed out**, so that component's manual
  `useMemo`/`useCallback` is the ONLY memoization it has. Removing it because
  `react-compiler-no-manual-memoization` also fires is a performance regression,
  not a cleanup. Fix the bail-out first or leave both.
- **Measured 2026-09-25: the compiler skips every function with a destructuring
  default** (`({ size = "default" })`) — 454 of 1688 in `apps/web` +
  `packages/ui` + `packages/chat-ui`, including `MessageItem`, `MessageList`
  and chat-ui's `MessageContent`. It calls `path.isLVal()`, a method of
  `@babel/traverse@7`, whose `@babel/types` the global `"@babel/types": 8.0.4`
  override replaces (Babel 8 dropped `AssignmentPattern` from `LVal`); the
  `babel-plugin-react-compiler>@babel/types` override does not reach it. Check a
  component in the served dev module (`curl localhost:5173/src/…tsx`): compiled
  code starts with `const $ = _c(n)`. The other common bail-outs are cheap to
  avoid — no `throw`, `finally`, or `?:`/`&&`/`??`/`?.` inside a `try`/`catch`
  in a component (move it into a module-level helper), no ref read during render.
- **Chat rows are memoized on message IDENTITY.** `useUIMessages` structurally
  shares unchanged messages across live pushes (`lib/agent/share-unchanged-messages.ts`),
  and the chat action callbacks read `messagesRef`, not `messages` — a callback
  closing over `messages` changes the actions context on every push, which
  re-renders every row of the thread (measured: 400 content renders for a
  one-message change in a 200-message thread; now 1). The streaming reply
  batches chunks per animation frame (`createFrameBatcher`).

- **KaTeX and Mermaid must stay off the startup path.** Reach
  `@streamdown/math`/`@streamdown/mermaid` only through
  `@neore/ui/hooks/use-streamdown-plugins` — one static import anywhere makes
  them eager again. `reactjs-tiptap-editor` also carries KaTeX, so the tiptap
  editors are `lazy()` at their chat-route call sites. And never put a lazily
  loaded package in a `codeSplitting` group in `apps/web/vite.config.ts`: a group
  is one chunk, it swallows its members' dependencies, and one eager importer of
  any of them loads all of it (that is how `vendor-diagrams` put Mermaid back on
  the chat page). Measured win: chat route −1.9 MB raw / −534 KB gzip, extension
  panel −870 KB / −226 KB.

### Build and deploy

- **`alchemy.run.ts` is not typechecked.** No root `tsconfig.json` exists, so
  `pnpm lint:types` never sees the deploy entrypoint — and you cannot run it to
  check, because `tsx alchemy.run.ts` IS `pnpm run deploy`. Parse-check edits
  with `./node_modules/.bin/esbuild alchemy.run.ts --format=esm --outfile=/dev/null`
  and read carefully; a type error there surfaces for the first time in CI.
- **`backend/lunora-bindings.json` is a BUILD artifact.** Only
  `pnpm --filter @neore/backend run build` should write it (via
  `--emit-bindings`), and `alchemy.run.ts` reads it to derive the backend's
  Durable Objects, Workflows and crons — so a DO, Workflow or cron added to
  `schema.ts` reaches the deploy **only via a build**. Wiring `--emit-bindings`
  into the `dev` script is a trap: the dev manifest carries the **dev origin**,
  so it would overwrite the deploy input with localhost values.
  `backend/deploy-bindings.test.ts` guards the contract.
- **Cloudflare enforces the UNCOMPRESSED Worker size: 64 MiB.** Since
  2026-09-04 there is no gzip limit (the old 3 MB Free / 10 MB Paid gzip caps
  are gone), so a gzip figure a build prints is informational. `"minify": true`
  in `backend/wrangler.jsonc` stays — it is what kept the backend under the old
  gzip cap, and smaller still starts faster. Minify drops esbuild's `keepNames`,
  but the five classes `wrangler.jsonc` binds by `class_name` still export under
  their exact names — only internal identifiers mangle. The largest Worker is
  the Rust document-parser at 14.4 MiB.
- **What deploys is NOT `lunora build`'s bundle.** Alchemy bundles every Worker
  itself from its `entrypoint`, ignores `wrangler.jsonc`, and defaults to an
  unminified build with `process.env.NODE_ENV` = `"undefined"` (React's
  development builds). Unset, the backend would ship at 19.9 MB / 3051 KiB gzip.
  The deploy's esbuild options live in `scripts/worker-bundle.ts` (minify, an
  English-only zod-locales plugin, `NODE_ENV=production` for the backend) and
  `backend/deploy-bundle.test.ts` pins that every `Worker(...)` passes them.
  To measure the real deploy bundle without deploying, call Alchemy's
  `normalizeWorkerBundle(...).create()` from `alchemy/lib/cloudflare/worker-bundle.js`.
- **A barrel import can defeat tree-shaking even when every package says
  `sideEffects: false`.** `@react-email/components` re-exports `Tailwind` and
  `CodeBlock`, which were bundled at 435 + 555 KiB despite **zero** usages;
  naming the components directly (`@react-email/heading`, …) drops them to 0.
  pnpm does not hoist, so each must be a declared dependency. When a dependency
  looks too big for what you use, check `backend/.lunora/build/bundle-meta.json`
  before assuming the bundler handled it.
- **`lunora build --api-spec none` DELETES the git-tracked
  `lunora/_generated/openapi.{ts,json}`.** It saves ~860 KiB raw, but run
  `pnpm codegen` afterwards or you commit their deletion by accident.
- **The backend reaches its services over SERVICE BINDINGS, not URLs.**
  document-parser, browser-renderer and nsfw-checker are private (`url: false`
  in Alchemy, `workers_dev: false` in wrangler) with no auth of their own — the
  binding is the only way in. The gateway keeps its custom domain (browser
  `/v1/*`) and ONE shared secret, `LLM_GATEWAY_SIGNING_SECRET` ↔ gateway
  `SIGNING_SECRET`, for its calls back to the backend and the stream tokens.
  `embeddings` has no caller: private and unbound, and deployed with no
  `SIGNING_SECRET`, so its HMAC check fails closed. See
  "Services" under SUBSYSTEMS; `deploy-env-bindings.test.ts` pins it.

## A NOTE TO THE AGENT

We are building this together. When you learn something non-obvious, add it here
under the fitting topic — or in the nearest scoped `AGENTS.md` — so the next
change goes faster. Prune while you are there: a fact that no longer changes what
anyone does costs more to read than it is worth.
