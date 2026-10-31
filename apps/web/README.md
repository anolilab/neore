# Neore web

`@neore/web` is the main app: React with TanStack Start (file-based routing,
SSR) on a Cloudflare Worker. It talks to the Lunora backend through cRPC and to
the LLM gateway directly from the browser. The desktop shell and the mobile app
load or mirror this app; they are not built from it.

Conventions for working in the code (cRPC, feature layout, TanStack patterns)
are in [`src/AGENTS.md`](src/AGENTS.md) and [`AGENTS.md`](AGENTS.md). The
non-obvious runtime facts (live queries, auth, sharding) are in the root `CLAUDE.md`.

## Layout

| Path              | What is there                                                                     |
| ----------------- | --------------------------------------------------------------------------------- |
| `src/routes/`     | File-based routes; the root is `__root.tsx`, `routeTree.gen.ts` is generated      |
| `src/features/`   | One folder per domain (`chat`, `auth`, `canvas`, `pages`, `devices`, ...)         |
| `src/lib/lunora/` | The cRPC client (`crpc.tsx`), live-query bridge, shard routing                    |
| `src/locales/`    | Lingui catalogs: `de en es fr it ja pl pt zh`                                     |
| `e2e/`            | Playwright specs against a real backend and gateway                               |
| `scripts/`        | OG images, service worker, translation tooling                                    |
| `wrangler.jsonc`  | Worker entry and static assets; the deploy itself is `alchemy.run.ts` at the root |

## Configuration

`scripts/dev-setup.js` (`pnpm dev:setup` from the root) is the only thing that
writes `apps/web/.env`, seeded from `.env.example`. The client schema is
`src/lib/env.ts`, and three variables are required, so a missing one is a hard
boot failure:

| Variable               | Value                                               |
| ---------------------- | --------------------------------------------------- |
| `VITE_SITE_URL`        | This app's origin (`http://localhost:5173` in dev)  |
| `VITE_LUNORA_URL`      | The backend origin (`http://localhost:8788` in dev) |
| `VITE_LLM_GATEWAY_URL` | The gateway origin (`http://localhost:8787` in dev) |

`VITE_LUNORA_URL` must equal the backend's `PUBLIC_ORIGIN`: the JWT's issuer
and audience are pinned to it. Everything else in `env.ts` (PostHog, Turnstile,
consent, privacy links) is optional.

## Run it locally

From the repo root:

```bash
pnpm dev:setup      # once: env files, keys, local D1 migrations
pnpm dev            # web (5173), backend (8788) and the gateway (8787)
pnpm dev:app        # the web app alone
```

The app is on `http://localhost:5173`. `lunora dev`, started by the backend's
dev target, runs the backend's bound services (a copy of the gateway, document
parser, browser renderer, NSFW checker) in the same session; the browser's
`/v1/*` calls still go to the standalone gateway on 8787; see `services/*/README.md` and
"Services" in the root `CLAUDE.md`. Starting the backend needs the Rust
toolchain for the document parser unless `services/document-parser/build/`
exists.

Notes that bite:

- **Never set `server.warmup.clientFiles`** in `vite.config.ts`; it deadlocks
  the dependency optimizer. After a dependency change, clear
  `apps/web/node_modules/.vite`.
- **SSR markup is not evidence the app hydrates.** A 200 from `curl /` says
  nothing about the client bundle.
- The first `.global()` D1 access in a backend isolate costs about 3 s, so the
  first request after a restart is slow.
- `postinstall` runs `wrangler types` and `fumadocs-mdx`; do not commit
  `worker-configuration.d.ts` churn.

## Test and lint

```bash
pnpm --filter @neore/web test               # vitest
pnpm --filter @neore/web lint:types         # tsc --noEmit
pnpm --filter @neore/web lint:eslint
pnpm --filter @neore/web lint:prettier
pnpm --filter @neore/web translate:extract  # then translate:compile
pnpm --filter @neore/web test:e2e           # Playwright
```

The end-to-end suite drives a real browser against the dev stack. Its
`webServer` entries start the backend, the gateway and the app (and reuse any
that are already up outside CI), so check the ports before running it. The chat
specs need `MOCK_LLM=1` in `services/llm-gateway/.dev.vars`, which swaps every
model for a deterministic mock. Set `E2E_BROWSER_CHANNEL=chrome` to use an
installed Chrome. Specs use `awaitFormHydrated()` from `e2e/helpers.ts` before
submitting a form, because SSR paints inputs before React owns them. The
suite refuses to run against a hosted backend.

A change that touches the backend's API needs both trees type-checked: the
backend does not read its own inferred types back through `_generated/api.ts`,
but this app does.

## Build

```bash
pnpm build:chat                      # from the root: vis run build --projects=@neore/web
pnpm --filter @neore/web build       # og images, vite build, service worker, tsc
```

Deploying is CI's job (`alchemy deploy`, never `pnpm deploy` by hand). The
Worker is close to Cloudflare's module-size cap, so the root `scripts/worker-bundle.ts`
leaves browser-only chunks (spreadsheet editor, diagram layout, export
libraries) out of the upload and the root `scripts/check-web-size.ts` fails the
deploy past 60 MiB. A new heavy lazy chunk goes in `WEB_CLIENT_ONLY_CHUNKS`. Keep
KaTeX and Mermaid off the startup path by reaching them only through
`@neore/ui/hooks/use-streamdown-plugins`.
