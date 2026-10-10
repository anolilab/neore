# Document parser: Rust Worker now, a Container for large files next

Status: the Rust Worker is shipped (2026-10). The Container is the follow-up.

## Current design

`services/document-parser` is a Cloudflare Worker written in Rust: workers-rs
`0.8.7` plus the [xberg](https://crates.io/crates/xberg) crate `=1.3.2`
(default features off; `pdf` — xberg's pure-Rust `pdf-native` backend, no
pdfium — `office`, `excel-wasm`, `html`, `xml`, `archives`). It replaced the
TypeScript/Hono service on `@kreuzberg/wasm`.

- **Contract** (unchanged for the backend): `POST /extract`, raw body,
  `Content-Type` = the document's MIME type → `{ content, mimeType, tables,
  metadata }`; `GET /health`, `GET /health/live`. The OpenAPI description in
  `packages/service-sdk/openapi/document-parser.json` is now maintained by hand.
- **Private**: reached only over the backend's `SERVICE_DOCUMENT_PARSER`
  service binding; `workers_dev: false`, Alchemy `url: false`, no auth, no env.
- **Output shaping** (`src/shape.rs`, unit-tested on the host): xberg's
  plain-text renderer appends `(style_name: heading 1)` to every DOCX heading —
  stripped. Metadata drops `null` members. An unsupported `text/*` type (source
  code needs xberg's tree-sitter feature, left out) is retried as `text/plain`.
- **Build**: `pnpm --filter document-parser run build:worker`
  (`scripts/build.mjs`: `worker-build --release`, then `wasm-opt --strip-debug`
  to drop the name section worker-build keeps). Release profile: `opt-level =
  "s"`, fat LTO, one codegen unit, `panic = "abort"`, `strip = "debuginfo"`
  (`strip = true` breaks wasm-bindgen). `crate-type` is `cdylib` only — adding
  `rlib` grew the module by 2.8 MiB.
- **Deploy**: Alchemy uploads `build/index.js` + `build/index_bg.wasm` as built
  (`noBundle`, `scripts/worker-bundle.ts#RUST_WORKER_UPLOAD`) and refuses to
  start without them; CI builds first (`.github/actions/setup-rust-worker`).
  `limits.cpu_ms` is 60 000 — the backend's own deadline for the call.

## Limits, measured

| | |
| --- | --- |
| Module size | 14.4 MiB uncompressed, 5.7 MiB gzip (limit: 64 MiB uncompressed) |
| `opt-level = "z"` instead | 12.7 MB, but 2.2× the CPU on a 40 MB / 330-page PDF (1061 ms vs 488 ms) |
| Memory, typical PDF | ≈ 3.1 × input + 6 MB of linear memory; a 40 MB PDF hit the 128 MB isolate limit |
| Memory, text-dense PDF | 5 MB / 1,201 pages → 43 MiB; 15 MB / 3,603 pages → 110 MiB; 24 MB / 5,765 pages → 169 MiB |
| CPU, text-dense PDF | 6 s (5 MB), 20 s (15 MB), 36 s (24 MB), measured in local workerd |

So the **25 MB cap** (`MAX_DOCUMENT_BYTES` in `src/shape.rs` =
`MAX_EXTRACTION_DOCUMENT_BYTES` in `backend/lunora/lib/document-limits.ts`,
enforced in the composer, the upload route that receives the bytes, finalize,
extraction, knowledge ingestion and the Worker)
keeps an ordinary document well inside 128 MB. It is a BYTE cap,
not a guarantee: memory follows the amount of extracted text, so a synthetic,
wall-to-wall-text PDF near the cap can still exceed the isolate and fail. Such a
failure is a killed request; the backend records it as a failed extraction.

**Chat uploads reach the cap through the TUS upload route.** They used to go
through a `file.uploadFile` ACTION whose bytes travelled base64 in a JSON RPC
body, which Lunora caps at 1 MiB (a 900 KB PDF got `413` from `/_lunora/rpc`),
so chat documents topped out at ~750 KB. Now (`backend/lunora/lib/upload-route.ts`,
`file.ts`, `lib/chat-upload.ts`): the browser sends the file over TUS to
`/uploads` (`@lunora/storage/upload` over the R2 binding, 5 MiB chunks, with
progress); the route names the object `uploads/<userId>/<id>` from the caller's
identity, refuses a declared size over the declared type's cap (25 MB for a
document, 20 MB for images) or a type off the allowlist, and the provider
coalesces the chunks into an R2 multipart upload. `file.finalizeChatUpload` takes
only the `uploadId`, rebuilds the key under the caller's own prefix, re-checks
real size, type and leading bytes, stores it content-addressed through
`storeFile` (dedupe + grant) and deletes the staging object. Unfinalized staging
objects are reaped per key after an hour, with the shard housekeeping sweep as
backstop. The chip polls `file.getChatFileExtraction`, so it shows when the
text has landed.

The body is read into a buffer sized from `Content-Length` up front (a doubling
`Vec` peaked at ~1.5 × a 25 MB body while it copied).

## Follow-up: a Cloudflare Container for documents above 25 MB

To support documents above 25 MB, move extraction to a **Cloudflare Container**
running xberg natively (its server binary / Docker image). A Worker isolate has
128 MB and PDF parsing needs ~3× the file size; a container has gigabytes, real
threads and no CPU-time cap of the same kind.

A container is also the **only route to OCR**: xberg's OCR backends (Tesseract,
ONNX/Paddle models) need native libraries and model files that cannot run in a
Worker isolate. Scanned PDFs and images-of-text stay unreadable until then.

Sketch:

1. A `Container` class (Durable Object-backed) in a small Worker, bound to the
   backend like today's service; the container image is xberg's server.
2. Route by size: keep the Rust Worker for ≤ 25 MB (cheap, instant cold start),
   send larger files — and OCR requests — to the container.
3. Raise `MAX_EXTRACTION_DOCUMENT_BYTES` only for the routes the container
   serves; uploads already bypass the RPC body limit (the TUS upload route),
   so only its per-type cap has to follow.
4. Keep `/extract`'s contract so the backend's client does not change.

The `TODO:` at `MAX_DOCUMENT_BYTES` (`services/document-parser/src/shape.rs`)
and at `MAX_EXTRACTION_DOCUMENT_BYTES` (`backend/lunora/lib/document-limits.ts`)
point here.
