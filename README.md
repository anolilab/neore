# Neore Chat

An AI chat application: multi-model conversations, tools, document and image
handling, and a browser extension. Built with TanStack Start (React), a Lunora
backend on Cloudflare Workers, and a set of Hono and Rust Workers for media and
document processing.

> **License:** [FSL-1.1-ALv2](LICENSE.md) (Functional Source License). This is
> source-available, not open source under the OSI definition.

## Prerequisites

- **Node.js** 22.22 (see `.nvmrc`)
- **pnpm** 12 (pinned via `packageManager` in `package.json`)
- **Rust toolchain**, needed to start the backend the first time, because the
  `document-parser` Worker is built from Rust:

  ```bash
  rustup target add wasm32-unknown-unknown
  cargo install worker-build --version 0.8.7 --locked
  ```

  Skip this if `services/document-parser/build/` already exists.
- At least one AI provider key (for example an OpenRouter key) to get replies.

## Repository layout

```
apps/
├── web/                # Main web app (TanStack Start, React)
├── browser-extension/  # Browser extension (CRXJS + React)
└── native/             # Tauri v2 desktop and mobile shell around the web app
backend/                # Lunora backend: Durable Object shards, D1, R2, Better Auth
packages/
├── ai/                 # Model registry, prompts, design presets, tool definitions
├── chat-ui/            # Chat primitives (composer, thread)
├── service-sdk/        # Typed clients for the Workers services
└── ui/                 # Base UI component library
services/               # Workers: llm-gateway, document-parser, browser-renderer,
                        #   embeddings, nsfw-checker
docs/                   # User-facing documentation
plans/                  # Feature and design plans
```

## Getting started

```bash
pnpm install
pnpm dev:setup     # generates local keys and writes backend/.dev.vars and apps/web/.env
pnpm dev:chat      # starts the backend, the web app, and the LLM gateway
```

Then open http://localhost:5173.

| Service       | URL                    |
| ------------- | ---------------------- |
| Web app       | http://localhost:5173  |
| Backend       | http://localhost:8788  |
| LLM gateway   | http://localhost:8787  |

To run one part on its own, use `pnpm dev:app`, `pnpm dev:backend`, or
`pnpm dev:llm-gateway`. The backend runs as a daemon that outlives its
terminal, so stop it with `cd backend && ./node_modules/.bin/lunora dev stop`.

## Configuration

Templates live next to the code that reads them:

- `backend/.dev.vars.example`: backend secrets and provider keys
- `apps/web/.env.example`: web app build-time variables (`VITE_*`)
- `services/llm-gateway/.env.example` and `packages/ai/.env.example`: gateway and model settings

`pnpm dev:setup` fills in the required local values. Anything you add by hand
stays in the git-ignored `.dev.vars` and `.env` files. Never commit them.

For local development the backend needs only the core variables (auth secret,
encryption key, site URL). Email, OAuth, storage, and tool API keys have
development stubs and are optional.

## Scripts

| Command                       | What it does                                              |
| ----------------------------- | --------------------------------------------------------- |
| `pnpm dev:setup`              | First-time setup: keys and env files                      |
| `pnpm dev:chat`               | Backend, web app, and LLM gateway together                |
| `pnpm dev:app`                | Web app only                                              |
| `pnpm dev:backend`            | Backend only                                              |
| `pnpm build:packages`         | Build all shared packages                                 |
| `pnpm build:chat`             | Build the web app                                         |
| `pnpm lint`                   | Prettier, ESLint, and dedupe checks                       |
| `pnpm lint:types`             | TypeScript checks (run separately; `lint` does not include types) |
| `pnpm lint:eslint:fix`        | Fix ESLint issues                                         |
| `pnpm lint:prettier:fix`      | Fix formatting                                            |
| `pnpm lint:secrets`           | Scan for committed secrets                                |
| `pnpm env:generate-encryption`| Generate an encryption key                                |
| `pnpm clean`                  | Remove build artifacts and `node_modules`                 |

Tests run through the task runner: `pnpm vis run test` for everything, or
`pnpm test` inside a single project directory.

## Deployment

Deployment is handled by [Alchemy](https://alchemy.run) (`alchemy.run.ts`) and
runs in CI. Local deploys are for maintainers only:

```bash
DEPLOY_ENV=preview pnpm run deploy
```

Use `pnpm run deploy`, not a bare `pnpm deploy`: since pnpm 11 a script named
`deploy` shadows pnpm's built-in command.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
before opening a pull request. Report security issues privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## Tech stack

- **Web**: TanStack Start, React 19, Tailwind CSS v4, TanStack Router and Query
- **Backend**: Lunora on Cloudflare Workers (Durable Object shards, D1, R2, live queries)
- **Auth**: Better Auth, served by the backend
- **AI**: Multiple providers routed through the LLM gateway
- **Services**: Hono and Rust Workers (document parsing, browser rendering, moderation, embeddings)
- **Infrastructure**: Cloudflare Workers, D1, R2, Vectorize, Queues; deployed with Alchemy
- **Monorepo**: pnpm workspaces with the vis task runner

## License

This project is licensed under the **Functional Source License, Version 1.1, ALv2
Future License** (FSL-1.1-ALv2). See [LICENSE.md](LICENSE.md). Individual packages
may carry their own license; check the `package.json` in each directory.
