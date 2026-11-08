# USAGE — AGENT NOTES

## INVARIANTS

- **A reply's total is never lost to a project read** — a failed project
  read still records the total and skill rows; only the `__project__` row is
  best-effort, after `RECORD_RETRY`'s bounded retries. Both paths that read a
  project (`recordReplyUsage`, `forwardReplyUsage`) catch that read, record or
  forward the total first, and retry only the project. A side question reads
  no usage at all: it books `forwardReplyUsage` on the thread's shard. A new
  path that reads a project must keep this, with a test that fails the read.
  (Booking a record from an action stays best-effort, logged and never raised:
  `usage/schedule.ts`, and the side question's own booking in `chat/aside.ts`.)
- **Usage rollup** (`backend/lunora/usage/`) — the usage page's heatmap and
  per-skill breakdown read `usageDaily`, never messages. EVERY run path records
  through `usage/schedule.ts#scheduleReplyUsage` (afterRun, `runHeadlessAgent`,
  the Daily Brief) — a new run path that skips it is missing from the page.
  A side question is the one exception: it books `forwardReplyUsage` itself.
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
  user can open: no access files none, a failed read throws). A shared thread's
  record (and a side question's) goes through `forwardReplyUsage`, which reads
  the project on the thread's shard and passes it on as `threadAttribution`,
  checked again when the record lands. On a failed project read the
  record counts the reply at once without its project
  (`usageReplies.withoutProject`) and retries the project alone
  (`RECORD_RETRY`); a forward sends the total (`projectUnread`) and retries
  its read (`projectRetry`). A retry files the project once and clears the
  mark. A retry's record (`retry`) with no key counts the reply only within a
  day (`RETRY_COUNTS_WITHIN_MS`; keys are pruned after two); past that it notes
  its project on the key (`awaitingTotal`) for a first record still to come.
  Replies outside a project write none: "No project" is total − projects.
- **Project usage starts at deploy** — only replies recorded live are filed
  under a project. Older usage, and any reply the totals backfill counted,
  shows under "No project" until the project-history backfill ships (a later
  part). Do not file a project row for a reply the live record did not count.
