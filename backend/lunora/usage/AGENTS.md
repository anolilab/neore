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
  thread's shard passes `threadAttribution` (`getThreadAttribution`), checked
  again when the record lands; a shared thread's record goes through
  `forwardReplyUsage`. A failed project read never costs the total: the
  record counts the reply at once without its project
  (`usageReplies.withoutProject`) and retries the project alone
  (`RECORD_RETRY`); a forward sends the total (`projectUnread`) and retries
  its read (`projectRetry`). A retry files the project once and clears the
  mark. Replies outside a project write none: "No project" is total − projects.
- **Project usage starts at deploy** — only replies recorded live are filed
  under a project. Older usage, and any reply the totals backfill counted,
  shows under "No project" until the project-history backfill ships (a later
  part). Do not file a project row for a reply the live record did not count.
