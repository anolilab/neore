# SUB AGENTS — AGENT NOTES

Scoped notes, moved from the root `AGENTS.md`: what is non-obvious and still true here. Paths are
repo-relative. Project-wide rules stay in the root `AGENTS.md`.

## INVARIANTS

- **Sub-agents** (`sub-agents/`) — `delegateToSubAgent` admits a
  `subAgentRuns` row (owner of the parent thread only; depth ≤ 2 counted via
  `by_childThreadId`; ≤ 3 queued/running per PARENT THREAD — the tool cannot
  see its run; `subAgents/run` rate limit; one `chargeRound`), then the jobs
  queue runs `runHeadlessAgent` in a child thread linked by a
  `threadRelationships` row with `branchType: "subagent"`. `finishRun` is the
  only end of a run (frees the fan-out slot, notifies); a reaper fails a
  silent run. The post-back is `postRunResult`, once per `resultPostedAt`, and
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
