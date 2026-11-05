# BUILD AND DEPLOY

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## Build and deploy

- **Alchemy is 2.0 (beta), pinned EXACTLY** in the `iac` catalog. The beta ships about
  weekly and each release can move APIs; `minimumReleaseAge` also holds back the newest
  ones. Bump it deliberately, run `lint:types:deploy`, the five `deploy-*.test.ts`, then
  a `Deploy` workflow run with `dry_run` on `preview` before a real one. It is an
  Effect-based rewrite: `alchemy.run.ts` default-exports an `Alchemy.Stack`, and a
  resource's attributes (`worker.url`) are lazy `Output`s — compose them with
  `Output.map`, and never put one in a template literal (it prints `[object Object]`,
  which as a logical id collapses every id to one). `alchemy.run.ts` IS typechecked and
  linted (`pnpm lint:types:deploy`, `lint:eslint:deploy`, `tsconfig.deploy.json`), but
  running it is the deploy, so only the `dry_run` workflow input exercises it.
- **State lives in a Worker + Durable Object in the Cloudflare account**
  (`Cloudflare.state()`), bootstrapped by the first `alchemy deploy --yes` in CI. The CI token
  therefore needs Secrets Store access as well as Workers/R2/D1/Queues/Vectorize/KV. Local
  runs would use `.alchemy/`. `alchemy drift` (the `drift.yml` workflow) re-reads the cloud
  against that state. There is no `ALCHEMY_PASSWORD` any more.
- **`--adopt` is for the FIRST deploy of a name that already exists**, not a standing flag:
  it takes over any same-named resource. `deploy.yml` has an `adopt` input, off by default.
- **A prop that forces a REPLACE deletes a D1 database or R2 bucket outright** (alchemy
  2.0.0-beta.81). The replacement keeps the same name, so its reconcile finds the OLD resource
  by name and adopts its id instead of creating one; the cleanup then deletes that id. State
  ends up pointing at a deleted resource, the Workers' bindings with it, and the next plan
  calls it a no-op. That is how pinning `jurisdiction` (#496) emptied staging on 2026-11-04.
  Before changing a create-only prop (`jurisdiction`, a D1 `name`), read the plan for
  `replace` and rename the resource in the same change. To recover, run `deploy.yml` with
  `force`: every resource reconciles, finds nothing by id or name, and is created again.
- **Three tiers, three accounts.** `production` (the neore account), `staging` and `preview`
  (their own Cloudflare accounts, each with a GitHub environment holding its token and
  account id). The GitHub ENVIRONMENT picks the account and secrets; the Alchemy STAGE picks
  names and state. They differ only for a pull request preview: environment `preview`,
  stage `pr-<number>` (`preview.yml`, on the `preview` label, same-repo PRs, destroyed on
  close). `named()` suffixes everything with `-<stage>` except production, and the stage
  must stay the LAST part of a queue name: the backend binds `STAGE` and strips it in
  `queue()` (`backend/src/queue-stage.ts`), and the gateway's consumers tell a DLQ by
  `-dlq` in the name, not at its end.
- **Non-production stages live on workers.dev**, because the `neore.ai` zone is in the
  production account and a custom domain needs its zone in the Worker's account. The app
  bakes its URLs in at build time, so `deploy.yml` derives them BEFORE the build from the
  environment variable `WORKERS_DEV_SUBDOMAIN` (the account's workers.dev subdomain,
  registered once in the dashboard; names are global) and the Worker names:
  `https://<neore-chat|neore-backend|llm-gateway>-<stage>.<subdomain>.workers.dev`.
  `backend/deploy-env-bindings.test.ts` pins that the YAML and `alchemy.run.ts` agree.
  Unset, a non-production run falls back to the `VITE_*_URL` secrets.
- **Code blocks are highlighted by TanStack Highlight, not Shiki.** `@neore/ui/utils/code-highlighter`
  is a Streamdown `CodeHighlighterPlugin` (`name: "shiki"` is Streamdown's literal type, not a lie
  about the engine) over `@tanstack/highlight`: 39 languages in ~11 KB, where `@streamdown/code`
  pulled every Shiki grammar and theme (8 MiB of source in the server bundle, 133 language chunks
  in the client). A language it lacks (R, Scala, Haskell, Elixir, PowerShell, GraphQL, LaTeX, HCL,
  Zig, Julia, Objective-C...) renders as plain text, because `supportsLanguage` answers false and
  Streamdown skips highlighting. `EXTRA_ALIASES` maps `c`/`h` to the C++ grammar and `ini` to TOML.
  Streamdown reads a token's `color` as the light colour and `--shiki-dark` in its `htmlStyle` as the
  dark one, and `global.css` still has the matching `html.dark` rules; the plugin emits that shape. The
  Appearance theme NAMES are unchanged (so stored choices and `backend/lunora/auth/fields.ts` stay
  valid), and `code-highlight-themes.ts` holds a palette per name: five come from TanStack, the other
  eight are approximated from each theme's main colours. A theme name added to `code-themes.ts` needs
  a palette there, or it falls back to GitHub. Streamdown's own default pair is
  `["poimandres", "min-light"]` in `use-streamdown-appearance.ts`, a dark theme in the LIGHT slot;
  that predates the swap and was kept as is. `fumadocs` still bundles Shiki for the docs pages.
- **Cloudflare Access in front of staging and preview is opt-in** (`ACCESS_ENABLED=true`, an
  environment variable). It gates the web Worker only, to the `ADMIN` addresses: the browser
  calls the backend and gateway cross-origin, where the web hostname's Access login does not
  apply. It needs a Zero Trust organisation in the account and the token's account-scoped
  `Access: Apps and Policies Write` and `Access: Organizations, Identity Providers, and Groups
Write`; without them the deploy fails, hence the switch.
- **The web Worker is near Cloudflare's 64 MiB module cap, so it uploads without its browser-only
  chunks.** The SSR output is one chunk per `import()` target: ~3,300 chunks, ~68 MiB of JS,
  and the spreadsheet editor alone is 12 MiB. `WEB_CLIENT_ONLY_CHUNKS` in
  `scripts/worker-bundle.ts` names the ones only a click or effect loads (univer, elk, xlsx,
  jspdf, pptxgen, video-trim-encode); `WEB_UPLOAD_RULES` leaves them out (~52 MiB uploaded) and
  `scripts/check-web-size.ts` fails the deploy before the upload when the total passes 60 MiB.
  Excluding a chunk the server DOES import makes that lazy boundary fail on the server, and
  React renders it on the client instead; a new heavy lazy chunk goes in the list, not in the
  cap. Cloudflare's error names no file, only "exceeded the uncompressed size limit", and
  every Worker that depends on the website fails with the same message.
- **Held back on purpose**, each with a
  comment in `pnpm-workspace.yaml`: `typescript` 6.0.3 (packem's dts build cannot import TS 7),
  `@vercel/og` 1.0.1 (1.0.2 and 1.0.3 break `generate-og.mjs` with "Dynamic require of fs") and
  `@c15t/*` 2.3 (3.0 renames the provider, a migration). `alchemy` stays at beta.81 until a newer
  beta is a day old and a deploy has passed on it. The source of truth for Lunora versions is the
  catalog in `pnpm-workspace.yaml`, aligned to the cluster the meta-packages pin rather than the
  newest tags. The branded packages (`client`, `workflow`, `auth`) must resolve to one version
  each; a non-branded package may keep two copies when the meta-packages pin different versions,
  and that is not overridden.
  A meta-package release lags the package it pins by one release wave
  (`lunorash` 389 still pinned the `observability` that had the `ctx.db` facade bug when that was
  fixed), so wait until `npm view lunorash@alpha dependencies` shows the fixed version before
  bumping, rather than overriding.
- **Source maps go to PostHog and are deleted before the deploy.** `vite build` writes a `.map`
  per chunk (`sourcemap: "hidden"`); `dist/client` alone had 2,700 of them (~118 MiB, two thirds
  of the static-asset upload, all publicly served). `deploy.yml`'s "Build the web app, ship its
  source maps" step runs `scripts/upload-web-sourcemaps.sh`, which runs `posthog-cli sourcemap process` on `dist/client` (it injects a `//# chunkId=`
  comment into each chunk, which is how PostHog finds the map), then deletes every `.map`
  under `dist/`. One build produces both, so they cannot disagree; **never rebuild between
  upload and deploy**. Client only: a Worker stack trace has no chunk to look up, and the
  server maps are not uploaded by the rules anyway. The CLI is a pinned GitHub release with
  its SHA-256 (the npm package runs an unverified download script). Needs the environment
  secrets `POSTHOG_CLI_API_KEY` (a personal key with error-tracking write and organization
  read) and `VITE_POSTHOG_HOST`, and the variable `POSTHOG_PROJECT_ID`. The CLI wants the APP
  host, so the script derives `eu.posthog.com` from the ingestion host `eu.i.posthog.com`; the
  GDPR person-delete does the same (`gdpr/posthog-host.ts`). Without the key and project id
  the maps are deleted un-uploaded; a failed upload only warns. There are three different
  keys: the public project key (`VITE_POSTHOG_API_KEY`, events), the CI key above, and
  `POSTHOG_PERSONAL_API_KEY` (a runtime key bound to the Workers: local feature-flag
  evaluation and the GDPR person-delete, both OFF while it is unset). It needs the person
  write scope AND `project:read`: the delete answers 404 for an unknown person and for a wrong
  project id alike, so a 404 is believed only after reading the project, and a 401/403 there fails the
  step with a "lacks the project:read scope" error in the log. Keep them separate.
- **A Worker cannot fetch another Worker of the same account on `workers.dev` unless it sets
  `global_fetch_strictly_public`.** The runtime answers with a **404** ("error code: 1042") in a few
  milliseconds, which looks like a missing route. Every non-production stage lives on workers.dev,
  and the web app (auth proxy `/api/auth/*`, server-side calls) and the gateway (its calls back to the
  backend) reach the backend by its public URL, so both carry the flag in `alchemy.run.ts`. A new Worker
  that calls another by URL needs it too; a service binding does not.
- **`deploy.yml` ends with a smoke test of the new deployment** (backend status, health, an RPC that
  reads a `.global()` table, the gateway, the web app), because Alchemy reports success while the app
  can still be dead: the first staging deploys passed with every backend request failing. A failure
  outside production also replays the RPC while tailing the Worker's logs; production's logs are never
  printed (the run log of this repository is public). `backend/deploy-smoke.test.ts` pins it.
- **A Worker that passes the size cap can still fail Cloudflare's startup check** ("Script startup
  exceeded CPU time limit", error 10021): the module-level code of the whole bundle may take 1 s of
  CPU, and it is checked at upload, so it first shows on a deploy. `cd backend && pnpm exec wrangler
check startup` profiles `lunora build`'s esbuild bundle, which is NOT what deploys (Alchemy bundles
  with rolldown); to profile the real one, take the `worker-bundles-<stage>` artifact that
  `deploy.yml` keeps (also when the deploy fails) and run `pnpm exec tsx
scripts/profile-worker-startup.ts <dir> <main>`. Local profiles swing ~100 ms (mostly GC): take
  the best of several.
  The generated app already loads `@lunora/auth` and the
  OpenAPI/OpenRPC/architecture documents on the first event (`_generated/authModule.ts`), not at
  startup; an evaluation error there now 500s the first request instead of failing the upload.
  Lazy function mode (`codegen.lazyFunctions`, see "Functions load lazily" in `backend/AGENTS.md`) also defers the
  queue registry, workflow and agent entrypoints (upstream measured -31 % on its synthetic app).
  The Creem SDK is loaded on first use in `src/server.ts`, not at startup, for the same reason.
- **Known gap: the three dead-letter queues' 14-day retention is not set.** `Queues.Queue`
  takes only a name, so they keep Cloudflare's default (4 days). Raise it with the Cloudflare
  API/CLI until Alchemy exposes it (alchemy-run/alchemy#2226).
- **`backend/lunora-bindings.json` is a BUILD artifact.** Only
  `pnpm --filter @neore/backend run build` should write it (via
  `--emit-bindings`), and `alchemy.run.ts` reads it to derive the backend's
  Durable Objects, Workflows and crons — so a DO, Workflow or cron added to
  `schema.ts` reaches the deploy **only via a build**. Wiring `--emit-bindings`
  into the `dev` script is a trap: the dev manifest carries the **dev origin**,
  so it would overwrite the deploy input with localhost values.
  `backend/deploy-bindings.test.ts` guards the contract.
- **Cloudflare enforces the UNCOMPRESSED Worker size: 64 MiB.** There is
  no gzip limit (the old 3 MB Free / 10 MB Paid gzip caps
  are gone), so a gzip figure a build prints is informational. `"minify": true`
  in `backend/wrangler.jsonc` stays — it is what kept the backend under the old
  gzip cap, and smaller still starts faster. Minify drops esbuild's `keepNames`,
  but the classes `wrangler.jsonc` binds by `class_name` still export under
  their exact names — only internal identifiers mangle. The largest Worker is
  the Rust document-parser at 14.4 MiB.
- **What deploys is NOT `lunora build`'s bundle.** Alchemy bundles every Worker
  itself (rolldown) from its `main`, ignores `wrangler.jsonc`, and defaults to an
  unminified build (React's development builds). The deploy's options live in `scripts/worker-bundle.ts` (minify,
  `keepNames`, an English-only zod-locales rolldown plugin, `NODE_ENV=production` for the
  backend) and `backend/deploy-bundle.test.ts` pins that every bundled Worker passes them.
  The web app and the Rust parser are NOT bundled by Alchemy (`bundle: false`): they are
  built ahead and uploaded as built. The real bundle lands in
  `.alchemy/bundles/<stack>-<stage>-<id>` after a run — measure the backend there.
- **A barrel import can defeat tree-shaking even when every package says
  `sideEffects: false`.** When a dependency
  looks too big for what you use, check `backend/.lunora/build/bundle-meta.json`
  before assuming the bundler handled it.
- **`lunora build --api-spec none` DELETES the git-tracked
  `lunora/_generated/openapi.{ts,json}`.** It saves ~860 KiB raw, but run
  `pnpm codegen` afterwards or you commit their deletion by accident.
- **The backend reaches its services over SERVICE BINDINGS, not URLs.**
  document-parser, browser-renderer and nsfw-checker are private (`workersDev: false`
  in Alchemy, `workers_dev: false` in wrangler) with no auth of their own — the
  binding is the only way in. The gateway keeps its custom domain (browser
  `/v1/*`) and ONE shared secret, `LLM_GATEWAY_SIGNING_SECRET` ↔ gateway
  `SIGNING_SECRET`, for its calls back to the backend and the stream tokens.
  `embeddings` has no caller: private and unbound, and deployed with no
  `SIGNING_SECRET`, so its HMAC check fails closed. See
  "SERVICE BINDINGS" in `backend/AGENTS.md`; `deploy-env-bindings.test.ts` pins it.
