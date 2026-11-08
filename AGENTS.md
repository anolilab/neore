# PROJECT KNOWLEDGE BASE

Neore Chat v2 — AI chat app: React + TypeScript frontend, a **Lunora** backend on Cloudflare Workers, in a
`@visulima/vis` + pnpm monorepo. The agent docs hold what is **non-obvious and still true**; this file is the index.

## STRUCTURE

```text
./
├── alchemy.run.ts          # Alchemy IaC — deploys every Worker + D1/R2/Vectorize/Queues
├── apps/
│   ├── web/                # Main React app (TanStack Start)
│   ├── browser-extension/  # CRXJS + React
│   ├── desktop/            # Electron 45 shell around the DEPLOYED web app
│   ├── cli/                # `neore` CLI for the public v1 API
│   └── mobile/             # Expo / React Native app
├── backend/                # Lunora backend (ShardDO + .global() D1 + R2), Better Auth
├── packages/
│   ├── ai/                 # MODEL_REGISTRY, prompts, design presets, tool defs
│   ├── chat-ui/            # Chat primitives (composer, thread) — no backend/auth/router imports
│   ├── client-runtime/     # Framework-free client runtime shared by web and mobile
│   ├── device-core/        # Rust core of device execution, `neore-host`
│   ├── device-core-node/   # N-API addon around device-core for the Electron shell
│   ├── service-sdk/        # Typed client for the Workers services
│   └── ui/                 # Base UI component library
├── services/               # 5 Workers: llm-gateway, browser-renderer, embeddings,
│                           #   nsfw-checker (Hono), document-parser (Rust)
└── docs/                   # User-facing docs tree
```

Entry points: `apps/web/src/routes/__root.tsx` (app), `backend/lunora/chat/execute.ts` (agent run),
`packages/ai/src/models/registry.ts` (models), `services/llm-gateway/src/` (gateway), `alchemy.run.ts` (infra).

## CONVENTIONS

- vis + pnpm workspaces, strict TypeScript. Target projects by their `package.json` name
  (`--projects=@neore/web`); `vis` ignores `project.json#name`.
- In `vis.config.ts`, `dependsOn` takes target names only (globs go in `inputs`), and outputs are written
  `{projectRoot}/dist/**/*`. Why: [docs/agents/tooling.md](docs/agents/tooling.md).
- Feature folders: `apps/web/src/features/<domain>/`. Backend data through cRPC (`@/lib/lunora/crpc`).
- Better Auth through the provided auth factories. TanStack Router + Query; lingui for i18n.
- pnpm 12: settings only in `pnpm-workspace.yaml`; a dependency with an install script must be listed in
  `allowBuilds`; required peers are declared by the package that uses them. Detail: `docs/agents/tooling.md`.

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

Always `pnpm`. Lint does not include types: run both. Git hooks format on commit and check formatting on push.

```bash
pnpm lint:types                          # vis run lint:types — NOT `pnpm typecheck`
pnpm lint                                # vis run lint:all: eslint + oxlint + oxfmt (Prettier for md) + dedupe; `lint:eslint:fix`, `lint:oxfmt:fix`
pnpm vis run test                        # every test; there is NO root `pnpm test` (`pnpm test` inside a project)
pnpm build:packages                      # then `pnpm --filter @neore/backend run build` for the Worker
cd backend && pnpm codegen               # backend codegen
```

## SCOPED KNOWLEDGE — READ BEFORE YOU TOUCH

Each area's rules live in an `AGENTS.md` next to its code (with a `CLAUDE.md` symlink), and the long ones link a
reference under `docs/agents/`; their paths are repo-relative unless noted. Claude Code loads a folder's file when it reads files there; other agents load only
the files from the root down to their working directory, so **read the file for a path before changing code there**.

| Working on                                                                          | Read                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Anything in `backend/` — Lunora, codegen, modules, validators, `ctx.db`, sharding, queues, crons, service bindings | `backend/AGENTS.md`, `backend/lunora/AGENTS.md`; upstream issues: `docs/agents/lunora-upstream.md` |
| Auth, invite-only registration, RLS, the authz matrix                               | `backend/lunora/auth/AGENTS.md`                         |
| Utility models, claim-once and crypto, storage access                               | `backend/lunora/lib/AGENTS.md`                          |
| Edge streaming, rate-limit pause, approvals, low-risk check, side questions, secrets | `backend/lunora/chat/AGENTS.md`                         |
| Branches, agent switch, idle-thread summaries                                       | `backend/lunora/agent/AGENTS.md`                        |
| Tasks: rounds, the recurrence sweep, skipped slots, where a run goes               | `backend/lunora/tasks/AGENTS.md`                        |
| Host-run threads, coding agents on a paired computer                                | `backend/lunora/acp/AGENTS.md`                          |
| Messenger, memory, knowledge, usage, triggers, evals, sub-agents, pages, notifications, connectors, coding agents, chat import, source control, public API, devices | `backend/lunora/<folder>/AGENTS.md`                     |
| AI model registry, prompt optimizer, multi-reference images                         | `packages/ai/AGENTS.md`                                 |
| LLM gateway, video render queue, FAL media                                          | `services/llm-gateway/AGENTS.md`                        |
| Web app, frontend lessons, accessibility                                            | `apps/web/AGENTS.md`, `apps/web/src/AGENTS.md`           |
| Storybook: stories, MSW fixtures, page stories, a11y in CI                          | `apps/web/src/storybook/AGENTS.md`                      |
| Web auth (session reads), chat UI, local models                                     | `apps/web/src/features/{auth,chat,local-models}/AGENTS.md` |
| Desktop shell, dictation, ACP registry installs; mobile app; UI components          | `apps/desktop/AGENTS.md`, `apps/mobile/AGENTS.md`, `packages/ui/AGENTS.md` |
| Device execution, sandbox, SSH servers, `neore-host`                                | `packages/device-core/AGENTS.md`                        |
| Dev servers, build, deploy, pnpm, vis; review checklist and test rules for a PR      | `docs/agents/{local-dev,build-and-deploy,tooling,review-checklist,testing}.md` |

## A NOTE TO THE AGENT

Add what you learn to the scoped `AGENTS.md` nearest the code, not here. Keep every `AGENTS.md` under 100 lines:
rules in it, reasoning in its `docs/agents/` reference. A new one gets a `CLAUDE.md` symlink
(`ln -s AGENTS.md CLAUDE.md`) and a row above. Prune what no longer changes what anyone does.
