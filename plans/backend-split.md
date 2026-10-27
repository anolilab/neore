# Plan: splitting the backend across Workers

**Status:** proposal, 2026-10-14. Nothing is built. The first thing it asks for is a measurement.

## 1. The problem

The first staging deploy that got past the build was rejected at the backend:
`ScriptStartupError: Script startup exceeded CPU time limit` (Cloudflare error 10021). Cloudflare
allows 1 s of CPU for a Worker's global scope and checks it at upload. The `neore-backend` bundle
fails it, and so do the five Workers that run the same script (three workflows, the jobs consumer
and its dead-letter consumer). The limit cannot be raised.

## 2. What Lunora allows

Lunora cannot split the app itself (`plans/456` and `plans/457` in the Lunora repo):

- A **module** (`defineModule`) groups code inside one Worker. It is not a deployment unit.
- A **service** is a separate Worker the app calls over a service binding. It shares no database,
  no transactions and no live queries with the app.

So "splitting the backend" means running a **second Lunora app**: its own `lunora/` tree, schema,
`ShardDO` namespace, queues and cron, deployed as its own Worker, reached from the first over a
service binding or directly from the browser.

## 3. Measurements (2026-10-14, `wrangler check startup`, best of 5 on a quiet machine)

Local numbers are not Cloudflare's. The ratio is unknown (section 7); only the differences count.

| Build | Active CPU (best / median) |
| --- | --- |
| `main` | 343 / 371 ms |
| generated registry removed (no function modules, no validator installs) | 204 / 222 ms |
| only the 616 validator-install blocks removed, modules kept | 333 / 435 ms (no change) |

- Everything the generated `_generated/functions.ts` imports costs about **150 ms (~40%)**. The
  cost is evaluating the 173 function modules (builder chains, validators and their imports), not
  the `installCompiledValidatorMap(...)` calls.
- The other **~220 ms is a floor** no procedure-level split removes: the better-auth core and
  adapter (~25 ms in the unminified profile), zod (~10 ms), kysely, the framework, the schema and
  RLS for all 138 tables, and garbage collection. A second app pays its own floor again.
- The floor build is still 8.4 MB, against 11.1 MB: most code is reachable by other static
  imports (`chat`, `crpc`, the generated app), not only through the registry.
- The previous attempt to make our own `lunora/auth.ts` lazy showed no gain in the esbuild
  bundle. Whether a dynamic import becomes a real separate module in Alchemy's rolldown bundle is
  untested; PR #255 keeps that bundle so it can be.

## 4. Where a module split could cut

From `lunora/_generated/architecture.json` (1,074 functions, 35 modules). A cut is the number of
call, schedule, read and write edges that would cross between the two apps.

| Group | Functions | Edges out | Edges in |
| --- | --- | --- | --- |
| `pages`, `devices` | 59 (5.5%) | 0 | 0 |
| `browser`, `sandbox` | 28 (2.6%) | 0 | 29 (all from `chat`) |
| `knowledge`, `memory`, `vault` | 107 (10%) | 11 | 8 |
| `skills`, `prompts`, `system-prompts` | 73 (7%) | 6 | 11 |
| `workflow`, `tasks`, `triggers`, `evals`, `sub-agents` | 104 (10%) | 49 | 5 |
| the above plus `coding-agents`, `connectors`, `messenger` | 183 (17%) | 58 | 8 |
| every satellite (not `chat`, `agent`, `auth`, `gdpr`, root, admin, billing, notifications) | 460 (43%) | 69 | 50 |

The app is a hub. `chat` (178 functions) and `workflow` call `agent` (161 functions, 24 tables);
nearly every satellite edge points into `agent` (40) or `chat` (15). Extracting the 43% means
turning about 120 call sites into cross-app calls.

**What that buys.** Moving 43% of the functions removes at most 43% of the ~150 ms registry cost:
about **65 ms, ~17% of the core's startup**, and the new app starts with its own ~200 ms floor. A
module split is a weak lever for this problem. The levers with the numbers behind them are in
section 6.

## 5. What a second app needs

Whatever is split, these have to be answered (they are the real cost, not the startup number):

- **Identity.** The core mints the JWT with `iss`/`aud` set to its own origin, and `server.ts`
  pins `jwtVerify` to `PUBLIC_ORIGIN`. A second app verifies the same tokens against the core's
  JWKS and accepts that issuer. It has no better-auth tables and never builds better-auth.
- **Web client and live queries.** `VITE_LUNORA_URL` is one origin today, with one WebSocket per
  shard and a single-use ticket (`/_lunora/ws-ticket`). Either a second client, ticket route and
  URL in the web app, or the core forwards RPC and sockets by function path (a proxy that has to
  carry the upgrade).
- **Sharding and RLS.** Each app has its own `ShardDO` namespace, so a user's rows for the
  satellite's tables live on the satellite's `shard:<userId>`. `lib/rls/policies.ts` is one file
  for all tables today; each app needs the policies for its own tables.
- **GDPR.** The deletion workflow reaches every table (`gdpr/steps/*`). A satellite registers its
  erasure (`<module>/gdpr.ts` already exists per module) and the core's workflow calls it over
  the binding; export and the account-merge job (`lib/account-merge.ts`) fan out the same way.
- **Queues and crons.** Each app has its own jobs queue and dead-letter queue (named with the
  stage last, stripped in `queue()`), and its own one-minute cron tick (Cloudflare allows 3
  triggers per Worker, so there is room).
- **Shared code.** Both apps need `lib/` (the `crpc` builders, RLS helpers, validators, env
  parsing, logger). That has to become a workspace package first; it is the largest single piece
  of work and is needed by every option that creates a second app.
- **Deploy.** New Worker, Durable Object and queue resources in `alchemy.run.ts`,
  `deploy-bindings.test.ts` and `deploy-env-bindings.test.ts` extended, and a second
  `lunora build` manifest.

## 6. The cheaper levers (and who owns them)

| Lever | Expected saving | Owner |
| --- | --- | --- |
| Lazy function registry: import a module on its first call | up to ~150 ms (~40%) | Lunora (codegen + dispatch) |
| Generated app imports `@lunora/auth` inside the auth setup, not at module scope | part of ~70 ms (auth barrel + better-auth core) | Lunora (`emit-app.ts`) |
| Two blocks that must not break when the above lands: `@visulima/disposable-email-domains` calls `fileURLToPath(import.meta.url)` at module scope (throws in a Worker) | correctness | Lunora / package |
| Module split into a second app | at most ~65 ms (~17%) | us |

These are being investigated in the Lunora repo (branch `spike/lazy-function-registry`); nothing is
filed yet.

## 7. Staged plan with gates

**Stage 0: measure, no code.**
1. Merge PR #255 and run a staging deploy: it keeps the real rolldown bundle. Profile it with
   `scripts/profile-worker-startup.ts` (best of 5). Check whether a dynamic import is a separate
   module there.
2. Calibrate local against Cloudflare. We know the current bundle is above 1 s there. A scratch
   upload of a trimmed bundle (the floor build) to a throwaway Worker in the preview account runs
   the same startup check without serving traffic and gives a pass/fail point. This creates a
   resource in a Cloudflare account, so it needs the owner's go-ahead.
3. Get the Lunora feasibility answer for the lazy registry.

*Gate:* if the floor build (204 ms local) is near the Cloudflare limit, no split of any size
passes, and the only way forward is the Lunora changes. If the lazy registry is feasible upstream,
prefer it: ~40% for one change, against ~17% for months of plumbing.

**Stage 1: pilot, only if Stage 0 says a split is still needed.** Extract `pages` and `devices`
(59 functions, zero edges) into a second app. It will not fix startup; it proves the plumbing:
shared package, identity, web client, deploy, GDPR fan-out. Gate: it deploys, passes its own
startup check, and a page can be created and deleted end to end.

**Stage 2:** `knowledge`, `memory`, `vault`, then `skills` and `prompts` (the edges into `agent`
become an RPC surface on the core). Gate: core best-of-5 drops by the expected amount.

**Stage 3:** the automation group (`workflow`, `tasks`, `triggers`, `evals`, `sub-agents`), which
needs the largest RPC surface into `agent` and `chat`. Only if the earlier stages were not enough.

Stop as soon as the core is under the threshold from Stage 0, with the satellite also under it.

## 8. Not measured

- Whether Alchemy's rolldown output turns a dynamic import into a separate module.
- `keepNames` (on for both bundles): it costs a `defineProperty` per named function; its effect
  on startup is untested, and workflow classes are found by name, so it may not be safe to drop.
- Parse and compile time of the script, which a split also reduces and the profile attributes to
  the bundler's init helper.
