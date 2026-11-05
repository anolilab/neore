# KNOWLEDGE — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Knowledge rerank** — `POST /internal/rerank` on the gateway wraps Workers AI
  `bge-reranker-base`; `retrieve.ts` blends its order with the RRF order instead of
  replacing it (the model is English/Chinese). `AI` is unbound in dev, so the route
  answers 503 by design and retrieval keeps the fused order. `workers-types` lost
  `query` from the model's input type — the request still needs it.
