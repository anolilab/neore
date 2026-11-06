# CHAT IMPORT — AGENT NOTES

## INVARIANTS

- **Chat import** — client parses the export → uploads normalised JSON to R2 →
  `startImportJob` kicks off a `@lunora/workflow` workflow that processes
  conversations in batches of 25. Progress is polled reactively off
  `chatImportJobs`. Parsers for ChatGPT (tree-based `mapping`), Gemini
  (`USER`/`MODEL`) and Claude (`human`/`assistant`) auto-detect from JSON shape.
