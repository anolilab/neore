# Document parser: Rust Worker now, a Container for large files next

Status: the Rust Worker is shipped (2026-10). The Container is the follow-up.

## Current design

`services/document-parser` is a Cloudflare Worker written in Rust: workers-rs
`0.8.7` plus the [xberg](https://crates.io/crates/xberg) crate `=1.3.2`
(default features off; `pdf` — xberg's pure-Rust `pdf-native` backend, no
pdfium — `office`, `excel-wasm`, `html`, `xml`, `archives`). It replaced the
TypeScript/Hono service on `@kreuzberg/wasm`.

- **Contract**: `POST /extract`, raw body, `Content-Type` = the document's MIME
  type → `{ content, mimeType, tables, metadata }` (plus `pages`, below); `GET
  /health`, `GET /health/live`. The OpenAPI description in
  `packages/service-sdk/openapi/document-parser.json` is maintained by hand.
  **`?format=markdown`** (optional; absent or `plain` is the old response,
  with the same JSON, and any other value is `400`) returns Markdown instead.
  xberg's `output_format = Markdown` keeps headings, lists and tables. A PDF is
  split into pages (`pages.extract_pages`), and so is a PPTX, which keeps
  xberg's plain output (one page per slide; its Markdown puts a slide's title
  and body on ONE `## ` line, so every slide became a section heading that
  swallowed its body).
  **Pages are structured, not text.** For a paged document the response carries
  `pages: [{ pageNumber, content }]`, in order, and `content` is the empty
  string, so the text is held once in the isolate. `pages` is absent for every
  other document and format, so those responses are unchanged. The Worker writes
  no page marker into any text: the old in-band `<!-- PAGE n -->` lines were
  forgeable, since a document containing such a line passed for a page
  boundary. The backend joins the pages back with a private-use sentinel line
  (`backend/lunora/knowledge/chunking.ts#markPage`), after stripping that code
  point from every page's text, so a document cannot write one. xberg's own
  `insert_page_markers` was never used: it HTML-escapes the marker
  (`&lt;!-- PAGE 1 --&gt;`) and glues it onto the next heading. Only knowledge
  ingestion asks for Markdown (`backend/lunora/knowledge/ingest.ts`): chat
  attachments keep plain text, because Markdown changes what a model reads and
  repeats tables that plain text only lists.
  **Deploy order: the parser ships before the backend.** An old backend reads
  the empty `content` of a Markdown-mode PDF or PPTX and fails that ingest with
  "No text content could be extracted"; the reverse order is harmless.
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
| Markdown (`?format=markdown`), synthetic 6.1 MB / 1,500 pages, ≈3.8 M chars out | 87 MiB (plain 45 MiB); 7.3–11.6 s (plain 4.5–6.4 s) |
| Markdown, synthetic 1.6 MB / 400 pages, ≈1.0 M chars out | 28 MiB (plain 19 MiB); 1.5–1.9 s (plain 1.3–1.7 s) |

The synthetic PDFs are generated (40 lines of 12 pt text per page, one 24 pt
heading per page), not fixtures; measured in local workerd, one fresh isolate per
mode, three requests each, memory read after the first. Markdown roughly doubles
the memory of dense text, so by linear extrapolation a text-dense PDF reaches
128 MiB near 9 MB in Markdown mode, against about 17 MB in plain mode. Ordinary
PDFs carry less text per byte and sit well below both. Knowledge ingestion has
no fallback to plain text yet: a document that does not fit fails there.

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

## Layout: what the Worker does and does not do (checked against xberg 1.3.2)

- **Running headers, footers, footnotes, watermarks and text repeated on most
  pages are dropped by default.** `config()` leaves `content_filter` at `None`;
  for PDFs, xberg reads `None` as `strip_repeating_text = true` and
  `include_headers/footers/footnotes/watermarks = false` (checked in
  `extractors/pdf/extraction.rs`, and the margin stripping in `pdf/native/text.rs`
  only switches off when `include_*` is set), the same as
  `ContentFilterConfig::default()`. Set the `include_*` flags only if a feature
  needs page furniture. Not asserted by a test here: no fixture PDF has a running
  header.
- **Multi-column reading order and the repair of rotated text need
  `pdf_options.reading_order`, which requires xberg's `layout-detection`
  feature** (an ONNX layout model). It is not compiled into the Worker, and
  turning it on without the feature is a validation error. Like OCR, it is a
  container-only capability: PDFs with several columns come out in the PDF's own
  content-stream order, which is usually reading order for single-column text
  and not guaranteed otherwise.
- **Pages, by format.** Markdown mode returns `pages` for PDF (real pages) and
  PPTX (slides). DOCX and XLSX get none: xberg fills `pages` for DOCX with
  one page and no real pagination, so a page number there would be a guess.
  A DOCX with explicit page breaks would need the breaks read from the XML;
  not done. `tables[].page_number` is still returned in both formats.
- **Escaping.** Markdown mode leaves xberg's `escape_markdown` at its default
  (`true`), so prose such as `#06-18` or `- clause` is backslash-escaped and
  cannot be read as a heading or a list by the chunker. The cost is a stored
  `\#`; the fixtures contain no such prose.

## Follow-up: a Cloudflare Container for documents above 25 MB

To support documents above 25 MB, move extraction to a **Cloudflare Container**
running xberg natively (its server binary / Docker image). A Worker isolate has
128 MB and PDF parsing needs ~3× the file size; a container has gigabytes, real
threads and no CPU-time cap of the same kind.

A container is also the **only route to OCR** (and to layout-detected reading order, above): xberg's OCR backends (Tesseract,
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
