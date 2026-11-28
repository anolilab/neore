# Retired memories

How a memory stops being current, and how the person brings it back (`backend/lunora/memory/retired.ts`).

## Retiring

- Every retirement goes through `supersedeMemory`, which takes a required reason. It writes `retiredReason` and
  `retiredAt` beside `supersededBy` and drops the row's vector in the same write.
- Reasons: `revised` (extraction's belief revision, the import's supersede, a requested save that matched a known
  row), `merged` (a reflection merge, and a promotion of repeated activities), `compressed`, `expired`, `decayed`,
  `contradicted` (a reflection revision that replaced one row by the other), `duplicate` (a belief revision's IGNORE:
  the newer row only restated the older, which stands), `brought_back_over` (the newer version
  retired when the person brought an earlier one back). Reflection reads the reason from the op's
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
  RLS) or not retired. It clears the three columns, sets `lastConfirmedAt`/`updatedAt` and `restoredAt` to now, lifts a
  confidence below `BROUGHT_BACK_CONFIDENCE` (one decay step above the retirement line), drops a `validUntil` already
  past (bringing it back is the newest statement that it holds), redacts the text again, and re-embeds it through
  `reembedRewordedMemory`.
- **Current version** (`currentSuccessor`): the list's "Now remembered as" and the swap both use the version current
  now, `supersededBy` followed past rows retired since (A → B → C gives C, at most 20 links). A chain that ends at a
  row retired by itself, leaves the caller's rows, loops or reaches a deleted row has none: no text, no swap.
- **Swap** (`replacesSuccessor`): a row retired as `revised`, `contradicted` or `brought_back_over` lost to another
  version of the same fact. Bringing it back says that version is wrong, so the current version is retired in the
  same write as `brought_back_over`, pointing at the brought-back row; bringing that one back swaps them again, so
  exactly one version is current after each step. Only while the current version is the caller's own active,
  unpinned row in the same scope; a pinned one stays, and both are current. The list's `replacesCurrent` says which
  rows swap, and the button reads "Bring back (replaces the current version)".
- **Protect**: a merged, compressed, expired, decayed or duplicate row's successor holds other facts too and stays
  active. Every brought-back row is left alone for `RESTORED_PROTECTION_MS` (30 days, `reflection-logic.ts`):
  reflection does not read it at all (`loadReflectionInputs`), so it is neither decayed, expired, revised, promoted
  nor merged, as survivor or absorbed; `applyReflectionOps` skips every op on it, so a run planned before the
  bring-back cannot undo it; the expiry pages skip it; compression neither reads it nor, in `saveMemoryBatch`,
  retires it. Extraction still revises it from a new statement of the person's own.
- The settings list reads again from its first page after a bring-back or any other change on the page (the pages
  are remounted and the pages read before are dropped from the cache), so a row retired again shows, and no row is
  skipped or repeated. Focus goes to the section's visible toggle once the row's button is gone.
- It works with memory off, like edit and delete: it is the person's own data. The settings section sits with the
  memory list, which shows only while memory is on.
