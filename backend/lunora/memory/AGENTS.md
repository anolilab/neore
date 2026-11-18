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
  extraction's 50. The action only plans; one mutation (`saveImportedMemoryBatch`) applies every merge,
  confirmation and insert after re-checking the memory setting, so turning memory off meanwhile writes
  nothing. It also re-checks exact text (the newest 5000 own active rows), so a repeat past the window or
  a second tab saving the same paste confirms, not adds. Vector dedup (`dedup.ts`, shared with extraction)
  walks hits best first, reads one past the window by its embedding id, and passes over a row of another
  scope (user vs bot) or one this save superseded. An import never revises a pinned row,
  and a merged text that fails the paste's rules saves the fact as new. Rows are `source: "imported"` with
  `importedFrom`; both actions refuse while memory is off. A confirmation whose row changed mid-save is
  saved as new (the batch reports `skipped`, the action retries); a merge whose text another own row holds
  confirms that row. Vector lookups are capped per save (`IMPORT_MAX_VECTOR_LOOKUPS`, subrequest budget); past
  it, and whenever a fact has no vector, dedup reads the 5000-row wide window by words.
- **Extraction** never revises a pinned row (a near-match is saved beside it), and its UPDATE applies only while
  the row still reads as the decided text (`reviseExtractedMemory`); otherwise the fact is saved as new. An
  applied UPDATE schedules `regenerateMemoryEmbedding`.
- **Vectors link only while the row reads as the embedded text** (`linkMemoryEmbeddings`, via `linkMemoryVectors`
  in `dedup.ts`): a vector whose row was edited meanwhile is deleted, and the edit's own re-embed is what counts.
