# Embeddings

A Cloudflare Worker (Hono) that turns text into vectors with Workers AI
(`bge-*-en-v1.5`). `docs/services/embeddings.mdx` predates the move to service
bindings and the Worker's removal from the deploy.

## Status: kept in the repo, not deployed, nothing calls it

This is the one service the backend does **not** bind: `backend/lunora.config.ts`
leaves it out on purpose, and `alchemy.run.ts` no longer deploys it. Memory and
knowledge embed through the LLM gateway (`/internal/*`, `gateway-embedding-model.ts`)
like every other model call, and there is no entry for this Worker in
`@neore/service-sdk`. Its `wrangler.jsonc` still marks it private
(`workers_dev: false`, no route), and `POST /embed` fails closed (500) when
`SIGNING_SECRET` is unset.

To bring it back, declare it in `alchemy.run.ts`, give it a caller (a binding
or URL) and a `SIGNING_SECRET` shared with that caller, in the same change.

## API

| Route         | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `POST /embed` | `{ texts: string[1..100], model? }` -> `{ embeddings, dimensions, model }` |
| `GET /models` | The allowed models and the default                                         |
| `GET /health` | `{ "service": "embeddings", "status": "ok" }`                              |

- Each text is at most 8,000 characters, the body at most 1 MiB (413 above it).
- Allowed models (anything else is a 400): `@cf/baai/bge-base-en-v1.5` (768
  dimensions, the default, which matches the memory vector table),
  `bge-large-en-v1.5` (1024) and `bge-small-en-v1.5` (384).
- Auth is HMAC-SHA256 over `METHOD\nPATH\nTIMESTAMP\nSHA256(body)`, sent as
  `X-Signature` and `X-Timestamp`, with a 30 s replay window. A missing
  `SIGNING_SECRET` is a 500, a bad signature a 401.
- A 120-requests-per-minute sliding window per isolate (429).

## Run it

```bash
pnpm dev:embeddings          # from the root; or: pnpm --filter embeddings dev
```

That serves `http://localhost:8790` with the inspector on 9233. Put the secret
in `services/embeddings/.dev.vars` (not committed):

```dotenv
SIGNING_SECRET=<any string; pnpm env:generate-signing-secret prints one>
```

The `AI` binding is declared at the top level of `wrangler.jsonc`, and wrangler
treats it as always-remote, so `wrangler dev` needs `CLOUDFLARE_API_TOKEN` in a
non-interactive shell. `pnpm dev:stack` starts it next to the web app, backend
and gateway; plain `pnpm dev` does not. It runs on its own port because it is not
in the backend's `lunora dev` session.

## Checks

```bash
pnpm --filter embeddings lint:types
pnpm --filter embeddings lint:eslint
pnpm --filter embeddings lint:prettier
pnpm --filter embeddings build      # wrangler deploy --dry-run
```

There are no unit tests. Deploys belong to CI (Alchemy); do not run the package's
`deploy` script or `pnpm deploy`.
