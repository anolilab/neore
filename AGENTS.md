# PROJECT KNOWLEDGE BASE

Neore Chat v2 — AI chat application. React + TypeScript frontend, a **Lunora**
backend on Cloudflare Workers, in a `@visulima/vis` + pnpm monorepo.

The agent docs hold what is **non-obvious and still true**. If something is
derivable by reading the code in under a minute, it does not belong. This file
is the index: what applies everywhere, and where each area's own `AGENTS.md` is
("SCOPED KNOWLEDGE" below).

## STRUCTURE

```text
./
├── alchemy.run.ts          # Alchemy IaC — deploys every Worker + D1/R2/Vectorize/Queues
├── apps/
│   ├── web/                # Main React app (TanStack Start)
│   ├── browser-extension/  # CRXJS + React
│   └── desktop/            # Electron 44 shell around the DEPLOYED web app
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
  **disabling input tracking without saying so**. A cache hit restores files
  only for declared `outputs`, written `{projectRoot}/dist/**/*` (a bare
  `dist/**/*` restores nothing): without them `build:packages` said "read from
  cache" and left a missing or stale `dist` in place. `ai` and `service-sdk`
  declare theirs for `build` and `build:prod` in `project.json`.

## ANTI-PATTERNS

- Never run `lunora deploy` or `pnpm run deploy` unless explicitly instructed —
  CI owns deployment.
- Never run git commands unless explicitly instructed.
- Before running `dev:*` to test a change, check whether a dev run is already up
  (`ss -lntp`: the app on 5173, the backend on 8788, the gateway and standalone
  services on 8787 to 8792, the inspectors on 9230 to 9235). If one is,
  ask before killing it. If none is, start the dev command the test needs.
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
# SHADOWS the built-in, so bare `pnpm deploy` now RUNS `alchemy deploy` — it no
# longer fails harmlessly with ERR_PNPM_NOTHING_TO_DEPLOY as it did on pnpm 10.
# Write `pnpm run deploy` anyway; `pnpm pm deploy` is the built-in. CI calls the
# CLI itself: `alchemy deploy --stage "$DEPLOY_ENV" --yes` (deploy.yml).
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
does.

Root prettier only covers `*.{json,yml,yaml,js,mjs,cjs,ts}` — **root markdown is
not linted**, so do not "fix" its formatting.

## SCOPED KNOWLEDGE — READ BEFORE YOU TOUCH

The invariants live next to their code, one `AGENTS.md` per area, each with a `CLAUDE.md` symlink beside it.
Claude Code loads a scoped file when it reads files in that folder; other agents load only the files from the
repo root down to their working directory. **Before changing code under a path below, read its file** if it is
not already in your context.

| Working on                                                                          | Read                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Anything in `backend/` — Lunora, codegen, modules, validators, `ctx.db`, sharding, queues, crons, service bindings | `backend/AGENTS.md`, `backend/lunora/AGENTS.md`          |
| Lunora upstream issues, advisor counts, duplicate `@lunora/*` copies                | `docs/agents/lunora-upstream.md`                        |
| Auth, invite-only registration, RLS, the authz matrix                               | `backend/lunora/auth/AGENTS.md`                         |
| Utility models, claim-once and crypto, storage access                               | `backend/lunora/lib/AGENTS.md`                          |
| Edge streaming, rate-limit pause, approvals, low-risk check, side questions, secrets | `backend/lunora/chat/AGENTS.md`                         |
| Branches, agent switch, idle-thread summaries                                       | `backend/lunora/agent/AGENTS.md`                        |
| Host-run threads, coding agents on a paired computer                                | `backend/lunora/acp/AGENTS.md`                          |
| Messenger, memory, knowledge, usage, triggers, evals, sub-agents, pages, notifications, connectors, coding agents, chat import, source control, public API, devices | `backend/lunora/<folder>/AGENTS.md`                     |
| AI model registry, prompt optimizer, multi-reference images                         | `packages/ai/AGENTS.md`                                 |
| LLM gateway, video render queue, FAL media                                          | `services/llm-gateway/AGENTS.md`                        |
| Web app, frontend lessons, accessibility                                            | `apps/web/AGENTS.md`, `apps/web/src/AGENTS.md`           |
| Web auth (session reads), chat UI, local models                                     | `apps/web/src/features/{auth,chat,local-models}/AGENTS.md` |
| Desktop shell, dictation, ACP registry installs                                     | `apps/desktop/AGENTS.md`                                |
| Device execution, sandbox, SSH servers, `neore-host`                                | `packages/device-core/AGENTS.md`                        |
| Mobile offline cache                                                                | `apps/mobile/AGENTS.md`                                 |
| UI components                                                                       | `packages/ui/AGENTS.md`                                 |
| Starting dev servers, slow or dropped local requests                                | `docs/agents/local-dev.md`                              |
| Build, deploy, Alchemy, Worker size limits                                          | `docs/agents/build-and-deploy.md`                       |

## A NOTE TO THE AGENT

We are building this together. When you learn something non-obvious, add it to the scoped `AGENTS.md` nearest
the code it is about, not here; a folder that has none gets one, with a `CLAUDE.md` symlink beside it
(`ln -s AGENTS.md CLAUDE.md`) and a row in the table above. This file holds only what applies everywhere:
structure, conventions, anti-patterns and commands. Prune while you are there: a fact that no longer changes
what anyone does costs more to read than it is worth.
