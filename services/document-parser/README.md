# Document parser

A Cloudflare Worker written in **Rust** (workers-rs 0.8.7 and the xberg crate,
pinned exactly) that extracts text, tables and metadata from PDF, Office,
spreadsheet, HTML, XML and archive files. Design, measured limits and the layout
rules xberg applies are in [`plans/document-parser.md`](../../plans/document-parser.md);
user-facing notes in [`docs/services/document-parser.mdx`](../../docs/services/document-parser.mdx).

## Who calls it

Only the Lunora backend, over the `SERVICE_DOCUMENT_PARSER` service binding
(`serviceFetch(ctx, "documentParser")`, through `@neore/service-sdk/document-parser`).
The Worker is **private**: `workers_dev: false`, no route, and Alchemy deploys it
with `workersDev: false`. It has no auth and no env of its own, because the
binding is the only way in. Callers are chat attachment extraction and knowledge
ingestion.

## API

| Route              | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `POST /extract`    | Raw body, `Content-Type` = the document's MIME type -> `{ content, mimeType, tables, metadata }` |
| `GET /health`      | Health                                                                                           |
| `GET /health/live` | Liveness                                                                                         |

- `?format=markdown` returns Markdown (headings, lists, tables). A PDF or PPTX
  comes back as `pages: [{ pageNumber, content }]` with an empty `content`.
  Absent or `plain` is the plain-text response; any other value, or a repeated
  `format`, is a 400.
- The 25 MB cap is one number in three places: `MAX_DOCUMENT_BYTES` in
  `src/shape.rs`, and `backend/lunora/lib/document-limits.ts` (also used by the
  composer through `@neore/backend/document-limits`).
  `backend/lunora/lib/document-limits.test.ts` pins that they agree.
- The OpenAPI description the SDK is generated from is maintained by hand in
  `packages/service-sdk/openapi/document-parser.json`.
- Output shaping (`src/shape.rs`) is unit-tested on the host: DOCX heading
  attributes are stripped, `null` metadata dropped, and an unsupported `text/*`
  type is retried as `text/plain`.

## Prerequisites

Building needs the Rust toolchain:

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
```

`worker-build` downloads wasm-bindgen, wasm-opt and esbuild itself. Where a
firewall blocks that, copies in `PATH` or `~/.cargo/bin` are picked up, or point
`WASM_BINDGEN_BIN`, `WASM_OPT_BIN` and `ESBUILD_BIN` at them. A cold release
build takes about six minutes.

## Build

```bash
pnpm --filter document-parser run build:worker     # -> build/index.js + build/index_bg.wasm
node services/document-parser/scripts/build.mjs --force
```

`scripts/build.mjs` runs `worker-build --release`, then drops the wasm name
section. It is skipped when `build/` is newer than the sources, so
`lunora dev` can call it on every start. Alchemy uploads `build/` as built and
refuses to start without it.

`wrangler.jsonc` calls the build through `pnpm --filter document-parser run
build:worker` and never `./build.sh` or `node scripts/build.mjs` directly: plain
wrangler runs a build command in the caller's cwd, and the backend, CI and the
deploy start from different directories.

## Run it

**Starting the backend needs the toolchain above**, unless
`services/document-parser/build/` already exists. In the full stack `lunora dev`
(started by the backend's dev target) runs this Worker inside the backend's own
`wrangler dev` session and has no port of its own.

Alone:

```bash
pnpm dev:document-parser       # from the root; or: pnpm --filter document-parser dev
```

That serves `http://localhost:8792` with the inspector on 9231. Check `ss -lntp`
first; 8788 belongs to the backend.

## Test and lint

```bash
pnpm --filter document-parser test            # cargo test --locked, then the workerd suite
pnpm --filter document-parser test:rust
pnpm --filter document-parser test:worker
pnpm --filter document-parser lint:types
pnpm --filter document-parser lint:eslint
pnpm --filter document-parser lint:prettier
```

`test:worker` runs `test/extract.test.ts` through wrangler's test harness against
the **built** module, so build first (`vis run test --projects=document-parser` does that through
the target's `dependsOn`; the package script alone does not). `test/fixtures/` holds the sample PDF, DOCX, PPTX and XLSX files.

The module is about 14.4 MiB uncompressed against Cloudflare's 64 MiB cap. Keep
`crate-type = ["cdylib"]` only; adding `rlib` grew it by 2.8 MiB. Deploys belong
to CI (Alchemy); do not run `pnpm deploy`.
