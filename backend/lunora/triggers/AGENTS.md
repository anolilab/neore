# TRIGGERS — AGENT NOTES

## INVARIANTS

- **Triggers** — schedule (cron, 1-min polling), webhook (HMAC-SHA256 at
  `/triggers/webhook/{triggerId}`), event (watchers, below). Execution uses headless
  `generateText` with auto-continue; each run creates a new thread tagged with
  trigger metadata.
  **Event triggers** (`triggers/events.ts`, sources in `triggers/event-sources/`) are a `triggers` row with
  `eventSource` (the condition: page, time or thread) and `eventState` (the baseline); `nextTriggerAt` is the
  NEXT CHECK, so the shard tick finds a watcher exactly as it finds a schedule. `dispatchDueEventTriggers`
  (tick, and `shardSweeps()` as backstop) leases a due watcher (moves `nextTriggerAt` out by 5 min) and
  schedules `runEventCheck`, an action because a page and a shared thread are outbound calls; no model is
  involved. The lease stamps `eventState.leasedAt`, which `recordEventCheck` clears: a watcher found due with the
  stamp still set had a check that never reported (it died, e.g. on the CPU limit), and that counts as a failed check
  the owner can fix — the third in a row pauses it (`failCheck`, shared with reported failures). `recordEventCheck`
  claims the occurrence (`claimOnce` on trigger + the source's fire key, TTL below the 5-min minimum interval) and
  does NOT enqueue: it records `eventState.pendingRun` and schedules `startEventRun`, which sends `executeTrigger`
  (`once`, job id from the firing) to the jobs queue and settles with `settleEventRun`. A refused send is retried
  with a doubling wait and, after `EVENT_RUN_MAX_ATTEMPTS`, given up (owner told). One firing waits at a time: an
  occurrence that fires while an earlier one is still pending is folded into it (`pendingRun.coalesced`) unless that
  one is past `EVENT_PENDING_RUN_HORIZON_MS`, when it is presumed dead and replaced. A one-shot (`time`) moment is
  switched OFF (`enabled: false`) once its own firing is consumed — `switchOffFiredMoment` when its run settles or is
  skipped as filtered, `switchOffConsumedMoment` when the run could not start or its queued delivery lapsed
  (the `onLapse` of `queueEventRun`), `settleEventRun` when the send is given up — each only for its own
  firing, so a manual run or an earlier arming cannot disarm it; `nextTriggerAt` is cleared on firing
  so it is not dispatched again meanwhile. Check failures
  use their own counter (`eventState.checkFailures`, same `advanceStreak` rule), not the run `failureStreak`.
  A page is fetched only through the SSRF-guarded `fetchWithTimeout` (redirects followed by hand, each hop
  re-checked), compared as visible text (never raw HTML), and its selector is a small subset (`page-extract.ts`:
  there is no DOM parser in the Worker; it is ONE forward pass, because a hostile page of unclosed tags made the
  earlier regex scan quadratic). A thread on another user's shard is scanned with `callOnShard` and access
  is re-read on every check. The excerpt reaches the run as `<event-data>` data, never as instructions.
