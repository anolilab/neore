# @neore/backend

The Neore backend, written with [Lunora](https://github.com/anolilab/lunora) and
deployed as a Cloudflare Worker: a `ShardDO` Durable Object per user, `.global()`
D1 tables for data read across users, R2 for files, and Better Auth for
accounts. It serves the web app, the browser extension, the desktop and mobile
apps, the `neore` CLI and the public `/api/v1` API.

Private (`@neore/backend`, FSL-1.1-ALv2). The deploy is Alchemy's
(`alchemy.run.ts` at the repo root); CI runs it.

## Layout

| Path                   | What lives there                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `lunora/`              | The application: `schema.ts`, `auth.ts`, `http.ts`, `crons.ts`, `queues.ts`, `workflows.ts` and one folder per feature                    |
| `lunora/<feature>/`    | A feature module. Each holds a `module.ts` (`defineModule({ description, tables })`) naming the tables it owns                            |
| `lunora/lib/`          | Shared helpers (shard context, job queue, services, claim-once, crypto, RLS in `lib/rls/`). Not a module                                  |
| `lunora/_generated/`   | Codegen output, committed. **Not hand-edited**                                                                                            |
| `src/`                 | The Worker entry (`server.ts`) and what must run before the generated app: shard routing, JWKS cache, queue-stage stripping, PostHog sink |
| `lunora.config.ts`     | Project config, read statically by codegen: the service bindings (`ctx.services.<key>`) and reviewed advisories                           |
| `wrangler.jsonc`       | Bindings; Lunora writes the `services[]` entries (the gateway's is hand-written)                                                          |
| `lunora-bindings.json` | A **build** artifact (`pnpm run build` writes it); `alchemy.run.ts` derives the backend's DOs, Workflows and crons from it                |
| `test/`                | The Vitest harness (`setup-harness.ts`) and stubs, including `cloudflare:workers`                                                         |
| `scripts/`             | `run-then-codegen.mjs`, `check-generated.mjs`                                                                                             |

The feature modules (`chat`, `agent`, `auth`, `memory`, `tasks`, `messenger`,
`devices`, `pages`, `knowledge`, `workflow`, `gdpr`, `public-api`, …) are listed
with their tables in each folder's `module.ts`. `lunora/README.md` describes the
files inside them, and `lunora/AGENTS.md` has the rules for editing handlers.

`package.json#exports` is the surface other workspace projects import (the
generated `./api`, `./schema`, `./dataModel`, `./server`, plus a few pure
modules such as `./agent/ui-messages`, `./document-limits`,
`./public-api/scopes`). Web code uses the backend through the cRPC client
(`@/lib/lunora/crpc`), not by importing handlers.

## Codegen

```bash
cd backend && pnpm codegen      # lunora codegen, then scripts/check-generated.mjs
```

- `_generated/` is not ours to edit. If generated output does not compile, fix
  it in our source, a `.d.ts`, or upstream.
- Codegen exits 0 even when it silently types an output `unknown`. After a
  codegen bump compare `cat lunora/_generated/{api,internal}.ts | grep -c "unknown>"`
  with the previous count, and typecheck **both** `backend` and `apps/web`.
- Build the workspace packages first in a fresh checkout (`pnpm build:packages`),
  or return types imported from `@neore/service-sdk` degrade to `unknown`.
- `lunora build` and `lunora prepare` re-run codegen internally; use the
  wrappers `pnpm --filter @neore/backend run build` / `run prepare:deploy`.
- Renaming or deleting an exported procedure while the backend runs kills it:
  add the new export, run codegen, then remove the old one.
- The advisor runs as an exit gate: `pnpm --filter @neore/backend run lunora:advise`.
- Every client-reachable procedure needs a reviewed row in
  `docs/security/authz-matrix.md`; `lunora/authz-matrix.guard.test.ts` fails
  when `_generated/api.ts` and the matrix disagree.

## Running locally

From the repo root (the dev stack is started by `vis`; check with
`ss -lntp` that one is not already up before starting another):

```bash
pnpm dev:setup      # writes .dev.vars and apps/web/.env (scripts/dev-setup.js)
pnpm dev:backend    # the backend on :8788 with its bound services in one wrangler session
pnpm dev            # web app, backend and the standalone llm-gateway (:8787)
```

- Port 8788 belongs to the backend; a new service takes the next free port
  after 8792. Wrangler inspectors are pinned (the backend session uses 9235).
- Logs go to `backend/.lunora/dev.log`: `cd backend && ./node_modules/.bin/lunora dev logs`.
- Stop the daemon with `./node_modules/.bin/lunora dev stop`; killing the
  `pnpm dev` root does not.
- Starting the backend needs the Rust toolchain for the `document-parser`
  service unless `services/document-parser/build/` already exists.
- In dev, mail is captured into the Lunora studio's Mail tab and never leaves
  the machine.
- Never run `lunora deploy` or `pnpm run deploy` locally.

## Testing and checks

```bash
pnpm --filter @neore/backend run test         # vitest run (harness in test/setup-harness.ts)
pnpm --filter @neore/backend run lint:types   # tsc --noEmit
pnpm --filter @neore/backend run lint:eslint
pnpm --filter @neore/backend run lint:prettier
```

Run `lint:types` to completion and trust its exit code, never a count of
`error TS` lines from a piped or timed-out run. The `deploy-*.test.ts` files at
the top of this folder pin that `wrangler.jsonc`, `alchemy.run.ts`, the build
manifest and the deploy workflow agree.

With `vis`, target the project by its `package.json` name:
`pnpm vis run test --projects=@neore/backend`.

## Where the rules are

The invariants live in the root `CLAUDE.md`; read the section before touching
the area instead of duplicating it here:

- "LUNORA": codegen, validators (`v` vs zod), modules and table ownership,
  advisories.
- "RUNTIME LESSONS (D1 vs DO)": `.global()` readers, sharding and scheduler
  lanes, the jobs queue, crons, auth, row-level security.
- "SUBSYSTEMS": services over bindings, edge streaming, storage access,
  device execution, the public API and everything else per feature.
- "INVITE-ONLY REGISTRATION" and "Build and deploy".

Plans: `plans/per-user-sharding.md`, `plans/backend-split.md`.
