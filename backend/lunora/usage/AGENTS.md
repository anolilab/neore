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
  `__project__` row (`projectKey` = project id), read when `recordReplyUsage`
  lands through `threadProject` (a sub-agent's or worker's thread: its lead's
  project, via `subAgentRuns`) and `readableAttribution` (only a project the
  user can open: no access files none, a failed read throws). A caller off the
  thread's shard passes `threadAttribution` (`getThreadAttribution`); a shared
  thread's record goes through `forwardReplyUsage`. Reading jobs are scheduled
  with `RECORD_RETRY` (a failed read fails the try); each also gets a fallback
  record (`RECORD_FALLBACK_MS`, no project) that adds nothing once the record
  landed, so the total always lands. Replies outside a project
  write none: "No project" is total − projects.
- **Project history cutoff** — the project walk (`runUsageProjectBackfillStep`)
  reconstructs nothing. It runs after the first walk, and files a reply only
  from the `counted` snapshot (amount and day) the first walk stored on its key.
  Under "No project" for good: a `usageBackfill` row without `timeZone`
  (written before projects were filed: no project walk), a key without
  `counted`, replies in threads the user does not own (teammates' shared
  threads; their live records file them), sub-agent threads whose
  `subAgentRuns` link was pruned (90 days). A day's project rows are clamped to
  that day's total row. Key pruning waits for both walks.
