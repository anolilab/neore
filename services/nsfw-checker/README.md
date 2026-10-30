# NSFW checker

A Cloudflare Worker (Hono, OpenAPI) that classifies an uploaded image with a
Workers AI vision model (`@cf/llava-hf/llava-1.5-7b-hf`) and returns five
probabilities. `docs/services/nsfw-checker.mdx` still describes HMAC auth and
`*_URL` wiring from before the service bindings; the code has neither.

## Who calls it

Only the Lunora backend, over the `SERVICE_NSFW_CHECKER` service binding. The
Worker is **private** (`workers_dev: false`, no route; Alchemy deploys it with
`workersDev: false`) and has no auth of its own, because the binding is the only
way in. The caller is `backend/lunora/agent/nsfw-check.ts`: after a chat file or
a vault file is stored, the scheduler runs an action that reads the bytes and
posts them through `@neore/service-sdk/nsfw-checker`. Where the binding is absent
the check is skipped with a warning, so a file never waits on it.

## API

| Route               | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `POST /classify`    | Raw image bytes in, scores out                                   |
| `GET /health`       | Health report (Workers AI state); `/health/live` is the liveness |
| `GET /openapi.json` | The OpenAPI document; 404 when `NODE_ENV` is `production`        |
| `GET /doc`          | Swagger UI over it                                               |

`POST /classify` takes the image as the request body with its `Content-Type`
(`image/jpeg`, `png`, `gif`, `webp` or `bmp`; anything else is a 400) and at most
10 MiB (413). It answers `{ neutral, drawing, sexy, hentai, porn, isNsfw,
topCategory }`, normalised to sum to 1. `isNsfw` is true when `porn` is above
0.5 or `sexy + hentai + porn` is above 0.7 (`NSFW_THRESHOLD` in
`src/lib/nsfw-classify.ts`). The model's reply is parsed from JSON; an
unparseable reply is a 500, which the backend records as a `failed` check.
Browser CORS is refused (`OPTIONS` answers 405), and the other responses carry a
`default-src 'none'` CSP.

## Run it

In the full stack you run nothing: `lunora dev` runs this Worker inside the
backend's `wrangler dev` session, with no port of its own.

Alone, for spec extraction (`pnpm --filter @neore/service-sdk generate:extract`)
or direct requests:

```bash
pnpm dev:nsfw-checker          # from the root; or: pnpm --filter nsfw-checker dev
```

That serves `http://localhost:8791` with the inspector on 9234. Check `ss -lntp`
first; 8788 belongs to the backend.

The `AI` binding is declared in `env.production` and `env.preview` only, not at
the top level of `wrangler.jsonc`. Wrangler treats `ai` as always-remote, so one
in the shared backend session would start a remote-proxy session that dies in a
non-interactive shell without `CLOUDFLARE_API_TOKEN` and takes the backend with
it. Locally the Worker therefore runs **without** `AI`: `/health`, the docs and
input validation work, and `/classify` fails at the model call. Alchemy binds
`AI` itself at deploy.

## Checks

```bash
pnpm --filter nsfw-checker lint:types
pnpm --filter nsfw-checker lint:eslint
pnpm --filter nsfw-checker lint:prettier
pnpm --filter nsfw-checker build      # wrangler deploy --dry-run
```

There are no unit tests. Deploys belong to CI (Alchemy); do not run the package's
`deploy` script or `pnpm deploy`.
