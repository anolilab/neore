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
  **Import** (`memory/import*.ts`): another assistant's memory, pasted. Lines are split by the pure parser and stored
  as pasted (the model labels `type`; only a belief-revision UPDATE rewords a row), so a repeat import is the same
  text and dedup confirms it. Near-match dedup reads a 1000-row window (type first, then newest), not extraction's 50.
  The action only plans; one mutation (`saveImportedMemoryBatch`) applies every merge, confirmation and insert after
  re-checking the memory setting, so turning memory off meanwhile writes nothing. It also re-checks exact text (the
  newest 5000 own active rows), so a repeat past the window or a second tab saving the same paste confirms, not adds.
  Vector dedup (`dedup.ts`, shared with extraction) walks hits best first, reads one past the window by its embedding
  id, and passes over a row of another scope (user vs bot) or one this save superseded. Rows are `source: "imported"`
  with `importedFrom`; both actions refuse while memory is off. The whole save is ONE write: a confirmation that
  cannot apply is inserted by that write, and a row the save confirmed or reworded is never superseded by a later fact
  of the same save. A merge whose text another own row holds confirms that row. Vector lookups (2 calls each, at most
  half) and belief revisions (1 each) share `IMPORT_DEDUP_CALL_BUDGET`, so a save stays under the Free plan's 50
  subrequests (`import.test.ts` counts a worst case). The 1000-row window widens to 5000 once, on the first fact
  matched by words. A file import (`importMemoryFile`, `import-file-logic.ts`) is bounded, batched, keyed by `importDedupKey` (full-width and ligature folds, not NFKC: `①` stays apart from `1`). A file never reaches `redactMultilineSecrets`: a text file with a secret label whose value does not end on its line (nothing after `=`/`:`, or an opened quote never closed on that line) is refused with the line number, a JSON item with one is skipped and counted invalid (`secretContinues`); every other line gets the paste's per-line redaction. The file limit is 500 KB, half the runtime's 1 MiB request body, for the JSON escaping of quotes, backslashes and line breaks. `content` is `v.sensitive`, so request logs mask it. Each batch goes through the paste's labelling call (`askImportLabels`, the prompt that drops medical diagnoses and other sensitive PII) before `importFacts`; an entry it drops counts as `invalid`, and no model allowed means nothing is written. It costs about 4 more subrequests per batch (the model lookup and the call), in the action; the inline file is one batch, so its worst case is about 44 of the Free plan's 50. A file over `MEMORY_FILE_INLINE_MAX_ENTRIES` is parsed at once (a refusal is returned, never queued), stored as redacted `memoryImportBatches` rows (never the raw file), and run by `import-job.ts`: one queue message per batch, each claimed in `claimImportBatch` (a redelivery finds it taken; `completeImportBatch`, fail, cancel and the reaper act only on the job's current batch), a batch is enqueued by the action only after the mutation that made it claimable committed (never inside it), two reapers guard it (one for a message nobody claimed, timed from the enqueue; one armed by the claim, timed from the claim), a batch that finishes after its job was cancelled or reaped still adds its counts (its memories stay; the job keeps its status and starts nothing), and whatever ends a job drops its rows (`gdpr.ts` erases them too). Once account deletion is under way, `prepareImportJob`, `storeImportBatches`, `beginImportJob` and `claimImportBatch` refuse or remove the job, and the job's save (`refuseDuringDeletion` on `importFacts` / `saveImportedMemoryBatch`) is refused inside the writing mutation; the paste and an inline file do not set it.
- **One decision per fact** for extraction and the import: `decideFact` (`dedup.ts`) confirms a match at 0.95 or more,
  revises only when the caller passes `revise` (extraction passes none for a pinned or other-day match), and saves the
  fact as new when a revision fails, is refused (`acceptMerge`) or carries no merged text.
- **Extraction** writes in order: revisions (`reviseExtractedMemory`, which re-embeds in the same write and applies
  only while the row reads as the decided text), then confirmations (`confirmMemories`, same check), then ONE save of
  every new memory, with the fallbacks of unapplied revisions and confirmations. A supersession applies only while
  its target still reads as the text the decision read (`saveMemoryBatch`, `supersedesBase`). A row revised earlier
  in one run is matched by words against its revised text, and carries the confidence its revision set.
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
  Confirmations write no memory text; one may add a quote that passed `evidenceQuote` to a row that has none. A fact
  that is nothing but a secret is dropped (`redactMemoryText` returns `null`), never saved as `«redacted»`:
  `insertMemory` returns `null` and supersedes nothing (the import reports `dropped`); a revision or import merge
  whose wording is only a secret does not apply, and its fact is saved as new, as for any that cannot apply; a dropped
  reflection merge or UPDATE wording keeps the rows it would absorb (and is not counted as merged or resolved). The
  import's exact-text and twin checks key on the redacted text. Compression that loses a fact this way does not run; a
  stored row that is only a secret is left out of compression, neither sent nor superseded. Reflection text (and the
  digest summary) is redacted before its cut to length, and a cut that removes every marker must still state a fact
  (`recheckCutMemoryText`); a belief revision's UPDATE text is not cut. Extraction (its facts, and its revision
  wordings), compression, reflection, the import save and the manual edit log one `memory.secret_redaction` event each
  (path, counts; no text); the backstops do not. A new write path calls the same helpers and `logRedaction`.
- **Dates** (`memory/dates.ts`): extraction writes relative dates out as absolute ones in the user's timezone and may
  set `validUntil` (last day a fact holds) and `eventStart`/`eventEnd` (local `YYYY-MM-DD`); yearly dates set none.
  Retrieval and dedup (`activeOn`, past the window too) skip an unpinned fact past `validUntil`; reflection retires it
  over every row read, before the 120-row selection (`splitExpired`), and keeps expired rows out of merges and
  revisions. **The newer statement decides the dates** (`restatedDates` only): a revision or confirming restatement
  writes the newer statement's three dates in place of the old, clearing one it does not carry (`dates` on
  `reviseExtractedMemory` / `updateMemoryInternal` replaces all three). The person's own edit in settings is the
  newest statement (`updateMemory` `dates`, checked by `userFactDates`). Extraction: UPDATE takes them; a restatement
  with other dates supersedes the row with the new statement, text and dates together (`restatementOutcome`), or is
  saved beside a pinned one (a pinned row's text and dates never change). An event on another day is another
  occurrence (`differentEventDays`): saved beside, never revised; a row superseded or confirmed in a run is not
  matched again (a revised one is, by its revised text and dates), and a statement the extractor returned twice is
  saved once. Relative dates resolve against the saved prompt's time; a steer sent on another day carries
  `[sent on <day>]` (`labelSentDays`, from its `sentAt`; steer offsets count the label, and `factEvidence` never
  quotes it). Reflection: only rows with the same dates cluster, so a merge never changes dates or leaves text naming
  another day; events on different days are never paired for revision. UPDATE, SUPERSEDE and IGNORE with other dates
  keep the newer row with its own dates; belief revision writes UPDATE's merged wording for them. Dated rows are never
  promoted or compressed. An import carries no dates and leaves a row's dates alone: a pasted line is not a newer
  statement. Like extraction it never matches, confirms or merges into an unpinned row past its end date (the action
  and the save, exact-text check included): the fact is saved beside it.
- **Provenance** (`memory/evidence.ts`) — `memories.evidence` holds a quote of the user's own words, its thread and
  message (the prompt's, or the steer's). **Evidence gate:** with `quotablePrompt` set, a fact with no verbatim typed quote is dropped before any
  save (`memory.evidence_gate`: counts, no text); the extractor reads no tool results; trigger runs pass `learn: false`. A quote is kept only through `evidenceQuote` over the TYPED text
  (`chat/lib/attached-text.ts`: no attachment, page capture or guest note; trigger, headless and outside-agent runs
  carry an empty one); it checks `containsSecret` and its own labels, and drops one naming a health condition. Merges take the
  newer quote, ranked by `evidence.at`: when the words were sent (`promptAt`, or the steer's own `sentAt`, stamped by
  `steerRun`), never when the job ran nor `updatedAt`; a belief-revision UPDATE (`reviseExtractedMemory`) takes its
  own quote; its `base` check leaves a row rewritten meanwhile alone. A reflection merge (`merge: true`) gives a
  quote-less survivor the absorbed quote, unless the user wrote it (`manual`); a contradiction never does; a merge
  applies whole or not at all (`staleMerges`: text or dates moved since the plan). Compression takes the newest quote
  its source rows hold at save time (`saveMemoryBatch`, `evidenceFrom`). A user's rewrite drops the evidence
  (`updateMemory`). The live list carries only `hasEvidence` and reads no thread; the quote and link come on expand
  from `getMemorySource`, which shows the quote only for the user's own chat (trash too) or a shared one they still
  hold a grant to, hides it otherwise (`quoteHidden`: the UI reads it, not `hasEvidence`), links only with `full`
  access to a thread not deleted, and gives the message's position so the chat can page back to it (capped walk).
