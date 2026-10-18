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
- **Reach:** only text that carries Markdown headings benefits (`.md` uploads,
  pasted Markdown, URL pages converted to Markdown). The document parser's
  renderer emits plain text for PDF/DOCX — it even strips heading attributes —
  so those files chunk exactly as before.

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

## Tests

- `chunking.test.ts`: heading boundaries, nested path, no-heading parity with
  the old output, oversize section still splits by size.
- `retrieve.rerank.test.ts`: rerank reorders; a 503, a malformed body or a
  throw keeps the fused order; ≤5 candidates skips the call; a reversed
  reranker cannot bury the fused top hit.
- Gateway `rerank.test.ts`: binding-only access, validation, the 503 without
  `AI`, clipping and the response parser.

## Out of scope

Knowledge graphs, CAG, and per-collection tuning (see `peer-gap-backlog.md`).
