# SUB AGENTS — AGENT NOTES

## INVARIANTS

- **Sub-agents** (`sub-agents/`) — `delegateToSubAgent` admits a
  `subAgentRuns` row (owner of the parent thread only; depth ≤ 2 counted via
  `by_childThreadId`; ≤ 3 queued/running/awaiting per PARENT THREAD — the tool cannot
  see its run; `subAgents/run` rate limit; one `chargeRound`), then the jobs
  queue runs `runHeadlessAgent` in a child thread linked by a
  `threadRelationships` row with `branchType: "subagent"`. `finishRun` is the
  only end of a run (frees the fan-out slot, notifies); a reaper fails a
  silent run. A cloud run's loop beats once a minute (`beatRun` → `beatAt`) and
  `watchRunBeat`, scheduled at `claimRun`, fails a run silent for 3 min with
  `INTERRUPTED_RUN_MESSAGE`: a dead worker's redelivery is refused by the claim,
  so nothing else ends it before the reaper. An interrupted run is not resumed (no
  tool marks yet). The parent's delegate call returned at admission, so it never waits on
  the child. The post-back is `postRunResult`, once per `resultPostedAt`, and
  WAITS while the parent thread has a pending/streaming `persistentStreams`
  row (backoff, posts anyway after ~36 min) — otherwise it lands between the
  delegating run's own steps. The delegate tool defaults to `ask`, and a
  headless run drops `ask` tools — so the child gets it back through
  `runHeadlessAgent({ approvedTools })` → `headlessApproved`: the parent's call
  only executed past its permission check, and that consent carries down
  (never over `off`, never to other tools, withheld at the depth cap).
  Triggers, tasks and messenger replies inherit nothing, so they lose it.
  **A worker can run on a paired computer** (`runner: { kind: "host", deviceId }`,
  `sub-agents/host-runs.ts`; agent-orchestrator.md S5): a run is the existing signed
  `acp_send`, started in the claim's transaction, never charged. A busy computer is not a
  failure: the run goes back to the head of its line and `retryHostRunStart` tries again, so the messages
  behind it do not meet the same refusal. Only a spent call budget counts toward `HOST_START_MAX_ATTEMPTS`; a turn
  holding the session (`holdsSession`) does not, the run polls every 30 s until it ends. A worker run's stop sends
  `acp_cancel` with `keepQueue` (signed; the core copies it into the command) so the worker's other queued messages
  survive; every other Stop leaves it out and the desktop drops what it queued.
  `functions.ts` and `acp/lib/finish.ts` load each other lazily, never statically.
- **A one-shot run can wait on an approval request** (`awaiting`, `markRunAwaiting`): it keeps its fan-out slot,
  and its deadline (`reapAt`) is the request's own expiry, when its reaper (`reapRun`, `oneShotReapDue`) fails it with
  `SUB_AGENT_APPROVAL_EXPIRED_MESSAGE`. A waiting run counts as active: a parent's Stop ends it, and every one-shot end
  denies the run's own open requests (`closeChildApprovals`, waited or not); `markRunAwaiting` closes the requests of a
  run that ended while recording them, or whose requests a later message moved past. Once a run has waited the beat watch
  stops (its continuation does not beat); `reapOverdueWaits` in `shardSweeps()` reaps an `awaiting` run whose reaper
  was lost (`by_status_and_reapAt`).
- **The owner answers a waiting run on the CHILD's thread** (`respondToToolApproval`):
  `claimToolApproval` refuses while the run is queued/running (`SUB_AGENT_STILL_WORKING`), once it ended (also for a
  request it closed, `SUB_AGENT_RUN_ENDED_BY`), and refuses `hour`/`today` (a headless child never reads timed grants).
  `resumeClaimedRun` → `resumeRunForAnswer` flips the run to `running` in the claim's transaction, before the stream and
  the job. The continuation stops at its next step once the run stops (`shouldRunStop` in its `stopWhen`) and hands its end back
  (`settleSubAgentRun`): every write is bound to the resume it runs under (`resumedWith` = that resume's `reapAt`), so a
  further pause waits again and an end finishes the run once (`completeResumedRun`) only while that resume is current;
  a failed write is scheduled again, bound the same way. A continuation that already settled is not ended by a later
  error. A resumed run ended from outside (a Stop, the reaper) also stops its live continuation stream at once
  (`liveContinuationOf`: the stream keyed on the run's `resumedBy` approval id, read exactly; `stopActiveForThread` with
  `onlyNamed`), so a tool in it gets the abort; only that stream and its goal.
- **The parent conversation shows a waiting child's requests** (`listSubAgentApprovals`, the card's `SubAgentApprovals`):
  the parent's owner only (NOT_FOUND otherwise, a locked parent needs its proof), bounded, with a locked child left out
  (its owner unlocks the child to answer). It admits the parent and every child, so it reads each child's latest turn
  through a reader keyed on that child (`admittedThreadMessages`): the guarded `ctx.db` would hand it the parent's rows. The card answers through `respondToToolApproval` on the child's thread, so the
  claim above decides, and it offers no allow for a period.
- **A one-shot child of the owner's own turn pauses on an `ask` tool** (`pauseForApproval` → `headlessCanAsk`, only
  when `originOfRun(dispatchedBy) === "lead"`): a chain a trigger, task, messenger reply or outside agent started drops
  `ask` tools as its parent run does, and so do workers. The run waits and is answered as above; its first pause is bound
  to "never resumed" (`resumedWith: 0`), so a late write never re-opens an answered run. A nested result waits
  while its parent's one-shot run goes (running or awaiting), so it never lands after a request; that run's end, waited
  or not, posts it (`releaseHeldResults`). A pause, first or continued, never overwrites a `"question"` the child thread
  waits on.
- **Lifecycle:** the send (`chat/http.ts`, any content type, a resend too, not a new thread) calls `afterOwnerMessage`
  after the save and its claim, in its own transaction, never failing the send: a run waiting on that child ends unless
  one of its requests is still open on the latest turn (read from the waiting runs and the turn, no row history), and the
  results held here are released. A hard delete marks every result bound for the thread `postFailed` and cancels its
  queue, both paged with a continuation past a per-call bound, then ends the runs it is the child of and those it
  delegated (`endSubAgentRunsOfDeletedThread`). A result for any parent with a request its owner can still answer
  (pending, unexpired, open on its latest turn) is held; an answer or a send releases it (`releaseHeldResults`), the
  backed-off recheck covers an expiry. Every end goes through `finishRun`.
