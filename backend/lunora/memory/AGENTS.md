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
  `importedFrom`; both actions refuse while memory is off. The whole save is ONE write: a confirmation that
  cannot apply is inserted by that write, and a row the save confirmed or reworded is never superseded by a later
  fact of the same save. A merge whose text another own row holds confirms that row. Vector lookups are capped per
  save (`IMPORT_MAX_VECTOR_LOOKUPS`); the 1000-row window is widened to 5000 rows once, the first time a fact must
  be matched by words.
- **Extraction** never revises a pinned row (a near-match is saved beside it). Its write runs in order: revisions
  (`reviseExtractedMemory`, which re-embeds in the same write and applies only while the row reads as the decided
  text), then confirmations (`confirmMemories`, same check), then ONE save of every new memory, with the fallbacks
  of unapplied revisions and confirmations. A supersession applies only while its target still reads as the text
  the decision read (`saveMemoryBatch`, `supersedesBase`). A row revised earlier in one run is matched by words
  against its revised text, and carries the confidence its revision set.
- **Vectors link only while the row reads as the embedded text** (`linkMemoryEmbeddings`, via `linkMemoryVectors`
  in `dedup.ts`): the mutation deletes a vector it does not keep (rejected, or replaced) through the retrying delete;
  a link mutation that fails deletes the vectors it carried. Every wording change (manual edit, import merge,
  `reviseExtractedMemory`, `updateMemoryInternal`, reflection) calls `reembedRewordedMemory` in the writing mutation:
  the old vector is dropped there, then the re-embed is scheduled on the owner's shard and links through the same
  check. A failed re-embed deletes nothing; the row is found by keyword.
- **No secrets in `memories`.** Every write redacts with `lib/secret-redaction.ts` first: extraction and compression
  facts (`redactMemoryFacts`, before embedding), extraction revisions (planned redacted, and `reviseExtractedMemory`
  again), reflection ops (`redactReflectionOps`), import lines (redacted before the cut to length, again after
  cleaning and after the cut, so preview and save agree; a quoted value the detector reads across lines, one without
  spaces, is redacted before the split) and merged texts, the manual edit (a text that is only a secret is refused),
  and `insertMemory` / `saveImportedMemoryBatch` / `updateMemoryInternal` / `applyReflectionOps` as the backstop.
  Confirmations write no text. A fact that is nothing but a secret is dropped (`redactMemoryText` returns `null`),
  never saved as `«redacted»`: `insertMemory` returns `null` and supersedes nothing (the import reports `dropped`);
  a revision or import merge whose wording is only a secret does not apply, and its fact is saved as new, as for any
  that cannot apply; a dropped reflection merge or UPDATE wording keeps the rows it would absorb (and is not counted
  as merged or resolved). The import's exact-text and twin checks key on the redacted text. Compression that loses a
  fact this way does not run; a stored row that is only a secret is left out of compression, neither sent nor
  superseded. Reflection text (and the digest summary) is redacted before its cut to length, and a cut that removes
  every marker must still state a fact (`recheckCutMemoryText`); a belief revision's UPDATE text is not cut.
  Extraction (its facts, and its revision wordings), compression, reflection, the import save and the manual edit
  log one `memory.secret_redaction` event each (path, counts; no text); the backstops do not. A new write path
  calls the same helpers and `logRedaction`.
- **Dates** (`memory/dates.ts`): extraction writes relative dates out as absolute
  ones in the user's timezone and may set `validUntil` (last day a fact holds) and
  `eventStart`/`eventEnd` (local `YYYY-MM-DD`); yearly dates set none. Retrieval
  and dedup (`activeOn`, also on rows read past the window) skip an unpinned fact
  past `validUntil`; reflection retires it over every row read, before the 120-row
  selection (`splitExpired`), and keeps expired rows out of merges and revisions.
  **The newer statement decides the dates** (`restatedDates`, the one place): a
  revision or confirming restatement writes the newer statement's three dates in
  place of the old, clearing one it does not carry (`dates` on
  `reviseExtractedMemory` and `updateMemoryInternal` replaces all three columns). The person's own edit in
  settings is the newest statement (`updateMemory` `dates`, checked by
  `userFactDates`). Extraction: UPDATE takes them; a restatement with other dates
  supersedes the row with the new statement, text and dates together
  (`restatementOutcome`), or is saved beside a pinned one (UPDATE and SUPERSEDE
  too: a pinned row's text and dates never change). An event on another day is
  another occurrence (`differentEventDays`): saved beside, never revised; a row
  superseded or confirmed in a run is not matched again (a revised one is, by its
  revised text and dates), and a statement the extractor returned twice is saved once. Relative dates resolve against the
  saved prompt's time; a steer sent on another day carries `[sent on <day>]`
  (`labelSentDays`, from the time the user queued it).
  Reflection: only rows with the same dates cluster, so a merge never changes
  dates (a pinned row's included) and never leaves text naming another day;
  two events on different days are never paired for revision either. UPDATE and
  SUPERSEDE keep the newer row (UPDATE takes the merged wording only when both
  rows' dates agree); IGNORE with other dates keeps the newer row.
  Dated rows are never promoted or compressed (both rewrite text without dates).
  An import carries no dates and leaves a row's dates alone: a pasted line is
  not a newer statement. Like extraction it never matches, confirms or merges
  into an unpinned row past its end date (action and save both check; the save's
  exact-text check skips it too): the fact is saved beside it.
