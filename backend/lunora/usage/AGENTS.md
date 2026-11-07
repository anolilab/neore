# USAGE — AGENT NOTES

## INVARIANTS

- **Usage rollup** (`backend/lunora/usage/`) — the usage page's heatmap and
  per-skill breakdown read `usageDaily`, never messages. EVERY run path records
  through `usage/schedule.ts#scheduleReplyUsage` (afterRun, `runHeadlessAgent`,
  the Daily Brief) — a new run path that skips it is missing from the page.
  A reply is keyed on its FIRST reply row id in `usageReplies`, which both
  the live record and the one-shot backfill (`usage/backfill.ts`) check, so
  redelivery and backfill/live overlap count once; the backfill's reply
  grouping (`backfill-logic.ts#groupReplies`) must keep matching what one run
  saves, or its keys stop lining up with the live ones. Keys are pruned only
  after the user's backfill is done.
- **Project rows** — a reply in a thread with a project also adds a
  `__project__` row (`projectKey` = project id), read from the thread when
  `recordReplyUsage` lands (pass `threadId`; rows carry it via `SavedRowLike`).
  Replies outside a project write none: "No project" is total − projects, so
  never write a project row for a reply the total does not count. The project
  walk (`runUsageProjectBackfillStep`) adds only project rows, and only for
  replies from before the first walk's cutoff (the only ones the total provably
  holds; later history stays "No project"); it skips keys the
  live path marked `projectFiled` and marks its own `project:<key>`, which the
  live path checks. Key pruning waits for both walks.
