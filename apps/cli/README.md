# neore CLI

`@neore/cli` is the `neore` command-line client for the public v1 API. It is a
thin Node program (no backend or web imports): every command is one or more
HTTP calls to `/api/v1/*` on the backend origin, authenticated with an API key.
The route table behind those calls is `backend/lunora/public-api/routes.ts`,
which also serves `/api/v1/openapi.json`. User-facing docs: [`docs/api.mdx`](../../docs/api.mdx).

## Authentication

An API key is the only credential. Create one in **Settings → API keys**
(a read and a write scope per resource) and save it:

```bash
neore login --api-url https://api.example.com   # prompts for the key, or reads it from stdin
neore whoami                                     # the key's user and scopes
neore doctor                                     # config, connectivity, key validity
neore logout
```

- The key is stored in the OS config directory with mode `0600`;
  `neore doctor` flags a looser file.
- `NEORE_API_URL` and `NEORE_API_KEY` override the saved file, for CI. So do
  `--api-url` and `--api-key`, but a flag ends up in shell history, so prefer
  the prompt or stdin.
- The API URL is the **backend** origin (the one the web app's `VITE_LUNORA_URL`
  points at), not the web origin.
- Keys work on `/api/v1` only; they cannot call the app's RPC endpoints.

## Commands

`neore --help` is the reference. Every command takes `--json` (NDJSON for
streams).

| Area      | Commands                                                           |
| --------- | ------------------------------------------------------------------ |
| Account   | `login`, `logout`, `whoami`, `doctor`                              |
| Chat      | `chat [prompt]` (no prompt opens an interactive session), `models` |
| Threads   | `threads ls`, `threads show <id>`, `threads rm <id> [--yes]`       |
| Skills    | `skills ls`, `skills run <slug> [input]`                           |
| Tasks     | `tasks ls`, `tasks create`, `tasks run <id>`, `tasks status <id>`  |
| Knowledge | `kb upload <file>`, `kb ls`, `kb search <query>`                   |

Exit codes: 0 ok, 1 error, 2 usage, 3 auth or missing scope, 4 not found,
5 rate or daily limit, 6 network.

`kb upload` goes over the TUS upload route (`/api/v1/uploads`, which needs a key
with `knowledge:write`), like every other upload in the stack.

## Develop

```bash
pnpm --filter @neore/cli build          # packem, development build -> dist/bin.js
node apps/cli/dist/bin.js doctor
pnpm --filter @neore/cli build:prod
```

Run it against a local stack: start `pnpm dev`, sign in to the app, create a key
in Settings, then `neore login --api-url http://localhost:8788`.

## Test and lint

```bash
pnpm --filter @neore/cli test           # vitest; src/cli.test.ts fakes fetch, no network
pnpm --filter @neore/cli lint:types
pnpm --filter @neore/cli lint:eslint
pnpm --filter @neore/cli lint:prettier
```

`neore` is private (`"private": true`) and requires Node 22.15 or later.
