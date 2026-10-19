# Knowledge retrieval quality — Implementation Plan

**Created:** 2026-10-19
**Status:** Implemented (2026-10-19)
**Scope:** `backend/lunora/knowledge/`, `services/llm-gateway/src/routes/internal/`

## Why

Retrieval is vector + BM25 fused by RRF (`hybrid.ts`) over chunks cut by
`chunkText` (`chunking.ts`), which splits on blank lines only. Two weaknesses:

1. A chunk does not know which section it belongs to, so "the limits" in a
   chunk under `## Rate limits` embeds and matches no better than any other
   "limits". `knowledgeChunks.metadata.sectionHeading` exists in the schema and
   nothing writes it.
2. RRF orders by rank only. The top 5 are taken from 15 candidates per leg
   without ever reading query and chunk together.

## Part A — heading-aware chunking

- `chunkText` tracks the current Markdown heading path (`# A` / `## B` →
  `"A > B"`), starts a new chunk at a heading boundary and returns
  `{ content, index, sectionHeading? }`. Text with no headings must chunk
  EXACTLY as before (a test pins it), so existing files and behaviour are
  unchanged.
- The embedding input is `sectionHeading + "\n\n" + content` (capped at the
  existing 2000 chars); the stored `content` stays the chunk body so citations
  and the keyword leg are untouched.
- `saveChunks` takes an optional `metadata.sectionHeading` and writes it.
- No migration: the field is already optional; old chunks simply have none.
  Re-ingest picks it up.
- **Reach:** text that carries Markdown headings benefits: `.md` uploads, pasted
  Markdown, URL pages, and — since the parser's `?format=markdown` (see
  `docs/plans/document-parser.md`) — PDF, DOCX, PPTX, XLSX and HTML documents
  ingested into the knowledge base. Chat attachments still get plain text, so
  they chunk as before.

## Part B — rerank

- New gateway route `POST /internal/rerank` (reachable only through the backend's service binding, like `/internal/speech`):
  `{ query, documents: string[], topN }` → `{ results: { index, score }[] }`,
  backed by Workers AI `@cf/baai/bge-reranker-base` through `env.AI`. No `AI`
  binding (dev, per the "no `ai` at top level" rule) or a provider error →
  `503`, which callers treat as "no rerank".
- `searchKnowledgeBase` asks the fused legs (own shard and each shared
  collection owner's) for `RERANK_CANDIDATES = 15` instead of 5, merges, and —
  only when there are more than `MAX_RESULTS` candidates — reranks them through
  `fetchWithDeadline` + `gatewayFetch(ctx)` (2 s deadline: it sits in front of every knowledge-grounded reply) and keeps the top
  `MAX_RESULTS`. Any failure falls back to the RRF order cut to 5, i.e. today's
  behaviour; a 503 (no reranker bound) is silent, anything else logs once.
- **The reranker orders are blended, not substituted:** the final order is the
  fused order and the reranker's order fused again by RRF (`applyRerank`).
  `bge-reranker-base` is an English/Chinese model and the keyword leg already
  handles German, so a wrong-language ordering must not be able to bury what
  both legs agreed on. `score` stays an RRF score.
- Not metered separately in v1 (Workers AI neurons are cheap); revisit if the
  gateway usage page needs it.

## Part C — page numbers in citations

- Ingest asks the parser for Markdown. A PDF arrives with a `<!-- PAGE n -->`
  line before each page, and a PPTX (plain text, one page per slide); `chunkText` drops those lines from
  the text, counts nothing for them (a chunk's boundaries are identical to the
  markerless text, pinned by a test), and records on each chunk the page its
  first paragraph is on. Overlap carried into a chunk starts on the page the
  previous chunk ended on.
- `saveChunks` writes it as `metadata.pageNumber`, the field the schema already
  had. Chunks with no page (DOCX, XLSX, old chunks) carry none.
- The page travels with the hit through both legs
  (`getChunksByEmbeddingIds`, `keywordSearchChunks`), RRF, the reranker's
  candidates, the chat tool result and the citation: the excerpt the model reads
  says `(passage 3, page 7)`, and the stored source's `providerMetadata` carries
  `pageNumber`. Every output validator on that chain declares it as optional.
- `searchKnowledge` (the public v1 API) now maps its hits to the four fields it
  declares. It returned the full hit, which `.output()` rejects
  (`rejectUnknownKeys`), so the endpoint failed on any hit before this change.
- **Not done:** the citation chip in `apps/web` (`knowledge-source-group.tsx`)
  still shows only `Passage n`. Showing the page needs a new translated message
  in every locale; the value is already on the citation.


## Tests

- `chunking.test.ts`: heading boundaries, nested path, no-heading parity with
  the old output, oversize section still splits by size.
- `retrieve.rerank.test.ts`: rerank reorders; a 503, a malformed body or a
  throw keeps the fused order; ≤5 candidates skips the call; a reversed
  reranker cannot bury the fused top hit.
- Gateway `rerank.test.ts`: binding-only access, validation, the 503 without
  `AI`, clipping and the response parser.
- `chunking.test.ts` (Part C): markers never change a chunk's text or
  boundaries (compared with the markerless text), a chunk starts on the page of
  its first paragraph, a heading that ends a page stays with its section,
  marker-only text yields no chunks.
- `retrieve.test.ts` (Part C, `lunoraTest`): `saveChunks` writes
  `metadata.pageNumber`; `getChunksByEmbeddingIds` and `keywordSearchChunks`
  return it, and leave it out for a chunk without one.
- `services/document-parser/test/extract.test.ts`: the plain format answers
  with the same JSON as before (the metadata's key order is xberg's own and
  varies between requests, with or without the option); `?format=markdown` keeps DOCX headings and tables and
  splits a two-page PDF at `<!-- PAGE n -->`; an unknown format is `400`.
- `shape.rs`/`lib.rs` unit tests: the format option, which formats are paged,
  the page join, and the Markdown extraction of DOCX and PDF fixtures.

## Out of scope

Knowledge graphs, CAG, and per-collection tuning (see `peer-gap-backlog.md`).
