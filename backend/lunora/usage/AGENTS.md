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
- **Organization view** (`organization.ts`) — at record time a reply in an
  organization's thread or project gets an `__organization__` row, and its
  project row carries `organizationId` only when the organization OWNS the
  project (a member's own project stays theirs). The view sums the rows filed
  under the session's active org (never a client-given id), lists only projects
  the org owns now, and puts everything else in an anonymous "No project".
  The backfill never files history under an organization: no record says which
  one a past reply ran in. Totals only: running sums ride in an encrypted
  cursor (`usage-cursors`) bound to org, caller and period; never return a
  partial sum, page size or member-scoped figure. The admin role is checked on
  the `member` row on every call. Both walks date replies in the zone snapshot
  taken when the first walk started (`usageBackfill.timeZone`).
