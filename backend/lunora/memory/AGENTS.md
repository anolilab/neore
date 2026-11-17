# MEMORY — AGENT NOTES

## INVARIANTS

- **User memory** — extraction runs as a background action after each AI
  response; retrieval runs before generation with multi-signal scoring
  (semantic 0.45 / confidence 0.18 / importance 0.12 / recency 0.25, 30-day
  half-life). Dedup threshold 0.85; conflicts go through belief revision
  (UPDATE/SUPERSEDE/IGNORE/ADD). **`memoryEnabled` on `userSettings` is OPT-IN —
  absent means off.** `isMemoryEnabled` is the authoritative gate; the settings
  read and the UI fallback must agree with it.
  **Taxonomy** is `memory/taxonomy.ts` (identity / preference / context /
  activity / experience), a required `type` column.
  **Nightly reflection** (`memory/reflection*.ts`) uses NO cron: `afterRun`
  schedules `noteMemoryActivity`, which `runAt`s one run at the user's local
  03:xx, so only users active in the last day ever have one queued. Only
  `activity` decays; pinned rows are never decayed, merged away or promoted. The
  LLM only words merges/promotions/the digest — WHICH rows change is decided by
  the pure, tested planner. Injected memories are recorded on the reply's first
  row (`messages.retrievedMemories`) for the "memories used" popover.
  **Import** (`memory/import*.ts`): another assistant's memory, pasted. Lines are
  split by the pure parser and stored as pasted (the model labels `type`; only a
  belief-revision UPDATE rewords a row), so a repeat import is the same text and
  dedup confirms it. Near-match dedup reads a 1000-row window (type first, then newest), not
  extraction's 50; the save (`saveImportedMemoryBatch`) re-checks the memory setting and exact text (own rows only) in the mutation, so
  a repeat past the window or a second tab saving the same paste confirms, not adds. Vector hits
  are walked best first; one past the window is read by its embedding id (`getMemoriesByEmbeddingIds`),
  and a bot's row or one this save superseded is passed over. An import never revises a pinned row,
  and a merged text that fails the paste's rules saves the fact as new. Rows are `source: "imported"` with
  `importedFrom`; both actions refuse while memory is off.
