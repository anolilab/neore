# Retired memories

How a memory stops being current, and how the person brings it back (`backend/lunora/memory/retired.ts`).

## Retiring

- Every retirement goes through `supersedeMemory`, which takes a required reason. It writes `retiredReason` and
  `retiredAt` beside `supersededBy` and drops the row's vector in the same write.
- Reasons: `revised` (extraction's belief revision, the import's supersede, a requested save that matched a known
  row), `merged` (a reflection merge, and a promotion of repeated activities), `compressed`, `expired`, `decayed`,
  `contradicted` (a reflection revision that replaced one row by the other). Reflection reads the reason from the op's
  shape (`reflectionRetiredReason`). There is no `manual` reason: settings has no retire action, only delete.
- Rows retired before these columns get `retiredAt` from the `backfill-memory-retired-at` migration (their last write,
  else their creation time) and no reason; the list shows "reason not recorded".
- No sweep deletes retired rows. A delete of a memory still removes the older rows that point at it
  (`deleteMemoryRows`), so a deleted memory's history is gone too and never listed.

## Listing

- `listRetiredMemories` pages `by_userId_retiredAt` (newest first, at most 50 a page). It names the replacing row's
  text and a bot only when the caller owns them, and never returns evidence quotes (those stay behind
  `getMemorySource` and its lock checks).
- The Markdown export reads active rows only and does not include retired ones; the GDPR export includes every row.

## Bringing back

- `bringBackMemory` (rate-limited as `memory/update`) refuses a row that is gone, another user's (NOT_FOUND under
  RLS) or not retired. It clears the three columns, sets `lastConfirmedAt`/`updatedAt` to now, lifts a confidence below
  `BROUGHT_BACK_CONFIDENCE` (one decay step above the retirement line), drops a `validUntil` already past (bringing it
  back is the newest statement that it holds), redacts the text again, and re-embeds it through
  `reembedRewordedMemory`.
- The row that replaced it stays active. The next reflection treats the pair like any other: a contradiction keeps the
  row created later (usually the successor), so a revised row is retired again; near-duplicates merge into the more
  confident, then more recently confirmed, row. Pinning the brought-back row keeps it.
- It works with memory off, like edit and delete: it is the person's own data. The settings section sits with the
  memory list, which shows only while memory is on.
