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
- **A one-shot run can wait on an approval request** (`awaiting`, `markRunAwaiting`; inert until pausing is turned on,
  as nothing passes `pauseForApproval` yet): it keeps its fan-out slot,
  and its deadline (`reapAt`) is the request's own expiry, when its reaper (`reapRun`, `oneShotReapDue`) fails it with
  `SUB_AGENT_APPROVAL_EXPIRED_MESSAGE`. A waiting run counts as active: a parent's Stop ends it, and the end denies the
  requests it waited on (`closeChildApprovals`, only for a run that waited); `markRunAwaiting` closes the requests of a
  run that ended while recording them, or whose requests a later message moved past. Once a run has waited the beat watch
  stops (its continuation does not beat); `reapOverdueWaits` in `shardSweeps()` reaps an `awaiting` run whose reaper
  was lost (`by_status_and_reapAt`).
- **The owner answers a waiting run on the CHILD's thread** (`respondToToolApproval`, inert until pausing is on):
  `claimToolApproval` refuses while the run is queued/running (`SUB_AGENT_STILL_WORKING`), once it ended (also for a
  request it closed, `SUB_AGENT_RUN_ENDED_BY`), and refuses `hour`/`today` (a headless child never reads timed grants).
  `resumeClaimedRun` → `resumeRunForAnswer` flips the run to `running` in the claim's transaction, before the stream and
  the job. The continuation stops at its next step once the run stops (`shouldRunStop` in its `stopWhen`) and hands its end back
  (`settleSubAgentRun`): a further pause waits again only for the resume that paused (`resumedWith` = its `reapAt`), an
  end finishes the run once (`completeResumedRun`), and a failed write is scheduled again.
