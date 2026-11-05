# CHAT IMPORT — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Chat import** — client parses the export → uploads normalised JSON to R2 →
  `startImportJob` kicks off a `@lunora/workflow` workflow that processes
  conversations in batches of 25. Progress is polled reactively off
  `chatImportJobs`. Parsers for ChatGPT (tree-based `mapping`), Gemini
  (`USER`/`MODEL`) and Claude (`human`/`assistant`) auto-detect from JSON shape.
