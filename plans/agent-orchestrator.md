# Agent orchestrator: persistent, addressable workers

Status: plan, 2026-10-26. Part of [agent-host-roadmap.md](agent-host-roadmap.md).
Extends `backend/lunora/sub-agents/`. Adds fields to `subAgentRuns` and `threads`
(§3 and §4) and no new tables.

## 1. Goal and decision

A lead agent in a thread hands work to **workers**. A worker is a thread the user
can open, read and message, and it keeps its context between dispatches. A
dispatch to a busy worker queues, or steers where the worker's runner supports
it. A worker runs in the cloud (a headless run, as sub-agents do today) or on a
desktop or SSH host as an ACP agent ([acp-agent-host.md](acp-agent-host.md)).

**Decision.** A worker is a sub-agent child thread that outlives one run.
`subAgentRuns` gains `mode` (`run` | `worker`) and `runner` (cloud headless, or a
host device). Each dispatch is one more run row on the same child thread. Every
sub-agent invariant stays: depth 2, 3 active runs per lead thread, claim-once on
dispatch and post-back, the post-back wait, cloud runs on the jobs queue.
Cloud worker runs are charged once via `chargeRound` when the run starts. Host
worker runs are not charged, and still count against the lead's
`subAgents/run:<tier>` rate limit.

### Native subagent or worker

Some harnesses run their own child agents. Neore must not guess which to use. The
rule, applied per task:

| Use a native child when | Use a worker when |
| --- | --- |
| the child needs no history and sends nothing later | the user should see the work, or message it |
| it finishes in one run, on the same machine as its lead | it must keep context across dispatches |
| its output is only a value the lead needs | it runs on a host, or under another runner |

A native child that runs on a host is not visible to Neore unless the agent
reports it. When the agent does report it, the child appears inside the parent's
tool call, with the rules in
[acp-agent-host.md](acp-agent-host.md) §4.7 (ownership by spawn id, buffering,
settling). Whether a given agent reports lineage is read from its capability
report, not assumed.

## 2. Current state (checked)

- `backend/lunora/sub-agents/logic.ts`: `SUB_AGENT_MAX_DEPTH = 2`,
  `SUB_AGENT_MAX_CONCURRENT = 3` (queued or running per parent thread),
  `SUB_AGENT_MAX_PER_RUN = 5` (lifetime children of a run at depth > 1),
  `SUB_AGENT_STALE_MS` (75 min reaper), `subAgentCapProblem`,
  `normalizeToolAllowlist`, `applyToolAllowlist`.
- `backend/lunora/sub-agents/functions.ts`: `admitSubAgentRun` checks the task,
  the account, parent-thread ownership, the caps, the `subAgents/run:<tier>` rate
  limit (`backend/lunora/lib/rate-limiter.ts`), then **charges via `chargeRound`
  at admission** (`backend/lunora/tasks/account.ts`). `claimQueuedRun` and
  `claimRun` claim a run. `attachChildThread` links the child.
  `postRunResult` posts once per run (`resultPostedAt`), waiting while the parent
  streams (`isThreadStreaming`, up to `SUB_AGENT_POST_MAX_ATTEMPTS`). `finishRun`
  is the only end of a run. `reapRun` handles silent runs.
- `backend/lunora/sub-agents/execute.ts`: `runSubAgent`, an internal action on the
  jobs queue, calls `runHeadlessAgent` in a **new** child thread. Headless runs
  create no persistent stream, so nothing can be steered into them.
- `subAgentRuns` (`backend/lunora/schema.ts`): `parentThreadId`, `childThreadId`,
  `depth`, `status`, `task`, `toolAllowlist`, `toolCallId`, `resultPostedAt`,
  ...; indexes `by_parentThreadId_and_status`, `by_childThreadId`,
  `by_user_and_toolCallId`.
- `threadRelationships` links child to parent with `branchType: "subagent"`.
- Web: `apps/web/src/features/sub-agents/components/sub-agent-tool-view.tsx` links
  to the child thread; `apps/web/src/features/chat/thread/sub-agent-parent-breadcrumb.tsx`
  links back.
- Task assignees are only the chat agent or a `codingAgent` assignment
  (`backend/lunora/coding-agents/validators.ts`). This plan does not change them.

Missing: a second dispatch with the same context, queueing behind a busy target,
host-run delegates, and a way for the user to address a delegate directly.

## 3. Data changes

`subAgentRuns` gains two optional fields (unset reads as today's behaviour):

```ts
mode: v.optional(v.union(v.literal("run"), v.literal("worker"))),
runner: v.optional(v.union(
  v.object({ kind: v.literal("headless") }),
  v.object({ kind: v.literal("host"), deviceId: v.id("devices") }),
)),
```

- **A worker's identity is its child thread.** Its name is the thread `title`,
  its model is the thread `model`, and "archived" is the thread's
  `status: "archived"`. No worker table, no worker id other than
  `childThreadId`.
- A worker's lifetime state is derived, never stored twice:
  - **exists**: the child thread is not deleted;
  - **archived**: thread status;
  - **live**: a run with that `childThreadId` is `running` (`by_childThreadId`).
- `runner` is fixed by the first run. Every later run copies it, and a dispatch
  with a different runner is refused.
- A host worker's child thread is created with `threads.runner = "host"` and an
  `acpSessions` row, through the remote-start rule: only an (agent, folder) pair
  already offered by that device ([acp-agent-host.md](acp-agent-host.md) §3).
- `backend/lunora/sub-agents/gdpr.ts` already erases `subAgentRuns` rows. The new fields need no
  new step. Worker threads are erased as threads.

## 4. Design

### Creating a worker

- From the lead agent: `delegateToSubAgent` gains `persistent: true` and `name`.
  It creates the first run with `mode: "worker"`, like today's admission but
  without charging (see Charging, §4).
- From the user: `createWorker` (authMutation, owner of the lead thread only,
  `.output()` declared) with name, model, runner and tool allowlist.
- A worker's tools are a subset of the lead's: `normalizeToolAllowlist` and
  `applyToolAllowlist`, unchanged. `headlessApproved` consent carries down as
  today, never past `off`, never to other tools, and is withheld at the depth
  cap.
- In v1 the lead is always a cloud thread. A host-run thread has no Neore tools
  to delegate with.

### Dispatch

- From the lead: a new tool `messageWorker({ worker, message })`, default mode
  `ask`. It claims `(userId, toolCallId)` under the `worker-dispatch` claim-once scope before the rate limit, the charge and the insert, and a redelivery returns the existing run's receipt. Delegation admission today stores the tool call id but never checks it, so this guard is new for workers; the same gap in plain delegation is a separate follow-up.
- Creating a host worker (`delegateToSubAgent` with `persistent: true` and a host
  runner) is forced to `ask` as `messageWorker` is. Delegate consent carries down
  through `headlessApproved`, so without this a trigger run could start a host agent
  with no click.
- A worker's tools are a subset of its lead's tools. Admission derives the lead's
  effective tool set (what the lead's own run could call, with `off` tools and tools a
  headless run drops removed) and intersects it with the requested allowlist before
  storing it. The existing `normalizeToolAllowlist` only checks names, and the helper that
  applies an allowlist only filters the tools the child run builds for itself, so neither
  enforces this. Test: a tool a headless worker could run but its lead lacks is refused.
  A worker a person creates (`createWorker`) has no lead run to intersect with, so its
  allowlist stands as asked and is bounded by the user's own headless permissions instead,
  which every run applies when it builds its tools.
- From the user: typing into the worker thread calls `dispatchToWorker`
  (authMutation, owner, `clientId` required). It dedupes through `claimOnce`
  scope `worker-dispatch`, key `<childThreadId>:<clientId>`, TTL 24 h. Add the
  scope to the table in the header of `backend/lunora/lib/claim-once.ts`.
- Every dispatch runs `subAgents/run:<tier>` and `subAgentCapProblem` before it
  inserts a row. The rate limit is keyed by user (`.limit(userId)`), not by lead,
  so it bounds all of a user's dispatches together. Admission never charges for
  `mode: "worker"`.
- **Host workers need a person.** `messageWorker` to a host worker always runs in
  `ask` mode, whatever the tool's configured mode, so each dispatch to a host
  needs a click in the app. Otherwise a prompt that reached a cloud lead (an
  outside agent's `send_message`, a messenger reply, a trigger) could drive an
  agent on the user's machine. Headless leads drop `ask` tools, and host-worker
  dispatch is never carried down through `headlessApproved`, so a headless run
  cannot reach a host worker at all.
- **Idle worker:** insert the run as `queued`. A cloud worker then gets
  `enqueueJob(runSubAgent)`; a host worker gets an `acp_send` device call.
- **Busy worker:** insert as `queued` behind the running one. When `finishRun`
  ends a worker run, it starts the oldest queued run with the same
  `childThreadId`. Queued runs count toward the lead's 3-active cap, so workers
  cannot widen it.
- **Steer.** The UI offers steer only when the worker runner's capability report
  says `turns.followUp` is `steer` ([provider-capabilities.md](provider-capabilities.md)).
  Cloud headless workers report `queue`. A host worker whose agent only
  interrupts shows "interrupt and restart". A steer on a host worker is an
  `acp_send` into the running turn, if the agent accepts one.

### Running

- **Cloud:** `runSubAgent` runs on the jobs queue in the **existing** child
  thread, with that thread's history as context (the normal context builder),
  instead of creating a new thread when `mode` is `worker`. Long runs never wait
  on a scheduler alarm, so the 15-minute alarm cap does not apply.
- **Host:** the run is a host turn. Its `turn_end` arrives on the ingest. Then
  `applyHostEvents` finds the running worker run by `by_childThreadId` and calls
  `finishRun`. If the host is offline (stale `devices.lastSeenAt`, or the device
  call expires unclaimed), the run fails at once with "host did not answer". It
  never sits queued for a host that may not return.
- **A worker-aware reaper.** Today `reapRun` is scheduled once, at admission, and fails
  the run at that deadline without looking at activity. That would fail a worker that is
  still making progress, and a queued run that has waited behind another. For
  `mode: "worker"` runs the reaper starts its clock at claim, not admission. When it fires,
  it checks the run's latest stream or host event: a run quiet for `SUB_AGENT_STALE_MS`
  fails, and one with newer activity is rescheduled from that activity. A queued run is
  never reaped by this timer; a stop or the queue itself ends it.

### Stopping and stuck runs

- Already in place: the owner can stop a run (`cancelRun`, and the stop control in
  the sub-agent tool view), and a lead's stop cancels its workers' runs
  (`cancelSubAgentRunsForStop`). A failed run posts its error to the lead
  (`postRunResult`). A cancelled run posts nothing, by design (`finishRun`).
- New, `stopWorker({ workerId, scope, clientId })`, owner-only. `scope` is
  `current` (the active run) or `all_queued` (the active run and every queued run
  behind it). The worker thread header shows the control. It is claim-once on
  `clientId`, and a stop on a run that already ended is a no-op.
- **Stuck runs.** A run with no stream or host event for `SUB_WORKER_QUIET_MS`
  shows "No progress for N min" in the worker thread and on the lead's worker row,
  with a Stop control. The value must sit below `SUB_AGENT_STALE_MS`; set it after
  measuring real quiet gaps. The reaper still fails the run at `SUB_AGENT_STALE_MS`,
  and that failure posts to the lead as an error, so the lead always learns the
  outcome.
- The quiet notice and the stale clock both pause while a run waits on a person (an
  approval or a question), so a host turn waiting on a permission answer is not
  reaped.

### Charging

| Runner | Charged | When | Rate limit |
| --- | --- | --- | --- |
| cloud headless, `mode: "run"` | once, `chargeRound` | at admission (unchanged) | `subAgents/run:<tier>` |
| cloud headless, `mode: "worker"` | once per run, `chargeRound` | in the claim mutation, when the run leaves `queued` (S1 confirms `chargeRound` works inside that mutation) | `subAgents/run:<tier>` at dispatch |
| host, `mode: "worker"` | never; the agent bills its own account | n/a | `subAgents/run:<tier>` at dispatch |

A queued run that is cancelled costs nothing. A claim whose `chargeRound` fails
ends the run as failed with the daily-limit message, and the queue moves on.

### Post-back

- Per run: `postRunResult`, waiting while the lead streams. Each dispatch is its own run
  row, so the existing dedupe covers it. No message-id dedupe is added. One thing
  changes: today `resultPostedAt` is set before the message is written, and `postToParent`
  returns without a message when the parent is deleted or locked, so the run counts as
  posted with nothing posted. S4 sets `resultPostedAt` in the same mutation as the
  successful message write. A parent that is unavailable leaves it unset, and the post is
  retried with backoff up to a bound, then ends in a terminal `postFailed` reason that the
  worker row shows.
- A worker that blocks on an approval or a question tells the lead and the user. The
  lead's wait then ends with "pending question", not with a timeout.
- Runs started by the lead post back. A run started by the user typing in the
  worker thread does not post back (§9 Q1). It has no `toolCallId` and is marked
  by that.
- A worker's replies stay in its own thread. The lead receives the bounded
  result (`truncateResult`, `SUB_AGENT_RESULT_MAX`) with a link to the worker.

### Report delivery and receipts

Failure modes to design out: a result that is lost, one that is retried forever,
and one undeliverable result that holds up the others. The post-back is already
one write per run, in the same transaction that sets `resultPostedAt`. These rules
make the guarantees explicit:

- **A dispatch returns a receipt.** `messageWorker` and `dispatchToWorker` return
  `{ runId, state }`, where `state` is `queued` or `running`. Never a bare "ok".
- **The post-back is per run.** A post that cannot land (the parent thread is gone,
  or the stream retry limit passed) retries on its own schedule and never holds
  another run's post.
- **Posted means written, not read.** `resultPostedAt` is the receipt. The result
  is a message in the lead's history, so it is in the lead's next context. The
  plan does not track whether the model used it; that boundary is stated, not
  hidden.
- **Lead-side state.** The lead's worker list shows each run as queued, running,
  posted, failed, or cancelled. A cancelled run has no post.
- **Host runs cannot vanish.** A host run that loses its host ends as "host did
  not answer", which posts as a failure.

### Dispatch policy and attribution

- A per-lead policy lives on the lead thread as an optional `workerPolicy` field,
  written through `agent/table-writes.ts`. Fields:
  - `hostDispatch`: always `ask`. The schema admits no other value.
  - `allowedSources`: a subset of `lead`, `user`, `trigger`, `messenger`,
    `outside_agent`. Default `lead` and `user`.
  - `maxDispatchesPerHour`: at most the `subAgents/run` tier limit.
- Each run row records `dispatchedBy`, one of the same sources. The worker thread
  shows "sent by" on each user-visible message, and the post-back names the source.
- A dispatch from a source that is not allowed fails at admission with a typed
  error, and charges nothing.
- `outside_agent` is off by default. It may be allowed for cloud workers only. Host
  workers never accept it (the outside-agent plan §3).

### Limits

- Depth stays 2. A worker at depth 1 may create its own workers at depth 2.
- In worker mode, the lifetime cap at depth > 1 (`SUB_AGENT_MAX_PER_RUN`) counts
  distinct worker threads, not dispatches. Otherwise a depth-2 lead could message
  its worker only five times.

## 5. Touchpoints

- `backend/lunora/sub-agents/logic.ts`: worker cap rule, runner equality, next
  queued run.
- `backend/lunora/sub-agents/functions.ts`: `createWorker`, `dispatchToWorker`,
  `listWorkers` (authQuery, by lead thread), `listActiveWorkerRuns` (authQuery,
  the caller's live runs through `by_user_and_status`, for the mobile running
  rail), worker branch in admission and claim, next-run start in `finishRun`.
- `backend/lunora/sub-agents/execute.ts`: reuse the existing child thread.
- `backend/lunora/sub-agents/validators.ts`: `mode`, `runner`.
- `backend/lunora/schema.ts`: the two fields.
- `backend/lunora/lib/claim-once.ts`: the `worker-dispatch` scope row.
- `backend/lunora/lib/job-queue.ts`: `enqueueJob` for cloud runs, as today.
- `backend/lunora/acp/`: `turn_end` hands back to `finishRun`.
- `apps/web/src/features/sub-agents/`: worker list under the lead, create
  dialog, queued badge.
- `apps/web/src/features/chat/thread/sub-agent-parent-breadcrumb.tsx`: the worker
  thread links back to its lead.
- `docs/security/authz-matrix.md`: rows for `createWorker`, `dispatchToWorker`,
  `listWorkers`, `listActiveWorkerRuns`.

## 6. Slices

**S1 — Cloud worker lifecycle.** Fields, `persistent` delegation, `createWorker`,
and run 2+ in the same child thread.
- Acceptance: two dispatches to one worker use one child thread; the second run's
  context contains the first run's reply; a redelivered `runSubAgent` job runs
  once; a redelivered lead dispatch with the same `toolCallId` inserts one run;
  admission in worker mode charges nothing, and the claim charges exactly once.

**S2 — Visibility and user messages.** Worker list under the lead, the worker
thread composer calls `dispatchToWorker`, and archive goes through the existing
thread archive. `listActiveWorkerRuns` (the caller's live runs, for the mobile
running rail in M5) is built here too.
- Acceptance: one message starts exactly one run; the same `clientId` twice
  starts one run; a redelivered `messageWorker` call returns the same run and charges once, with the claim taken before the rate limit; an archived worker refuses dispatch with a clear error; a
  stranger cannot list or dispatch (RLS and owner check); `/chat/start`, `send_message` and `POST /api/v1/chat` refuse a worker thread, because a worker turn runs only through `dispatchToWorker`.

**S3 — Queue and steer.** Busy-worker queueing, ordered start in `finishRun`,
capability-gated steer.
- Acceptance: with one run in progress, two more messages queue and run in
  order, and the next one is refused by the lead's 3-active cap; a cancelled queued run is never charged; the
  steer control is absent for a cloud worker.

**S4 — Post-back rules.** Lead-dispatched runs post back; user-typed ones do not.
- Acceptance: a result that arrives while the lead streams appears after the
  stream; a run posted twice shows once; a user-typed run posts nothing to the
  lead; a post to a deleted or locked parent leaves `resultPostedAt` unset, is retried,
  and ends in `postFailed` after the bound (test with a locked parent).

**S5 — Host workers.** `runner.kind = "host"`, a child thread with
`runner: "host"`, `acp_send` dispatch, `turn_end` → `finishRun`. Needs ACP S4.
- Acceptance: a dispatch reaches the agent on the host; an unoffered (agent,
  folder) pair is refused; host offline fails the run at once; no `chargeRound`
  call happens; the dispatch still consumes `subAgents/run:<tier>`;
  `messageWorker` to a host worker asks for approval even when configured `on`;
  a headless lead has no path to a host worker.

**S6 — Stop and stuck runs.** `stopWorker`, the worker-thread stop control, the
quiet notice.
- Acceptance: `current` stops only the active run; `all_queued` also cancels the
  queued runs and charges none of them; a second identical stop is a no-op; a run
  silent past `SUB_WORKER_QUIET_MS` shows the notice; a reaper failure reaches the
  lead as an error; a worker run that is active across the old fixed deadline is not
  failed, a queued run that waits longer than the deadline is not failed, and a run quiet
  for the full window is.

**S7 — Receipts.** Receipt fields on dispatch; per-run post-back isolation.
- Acceptance: `messageWorker` returns `runId` and `state`; when one run's post
  fails permanently, another run's post still lands; a host run whose host goes
  away posts "host did not answer" to the lead.

**S8 — Dispatch policy and attribution.** `workerPolicy`, `dispatchedBy`, the
"sent by" label.
- Acceptance: a dispatch from a disallowed source fails at admission and charges
  nothing; a host dispatch asks for approval even when the policy would allow it;
  the attribution shows on the run row and in the post-back.

**S9 — Cheap-first worker models with escalation (optional, measure first).** A
`workerPolicy.models` field: `"own"` (default, open question 3) or `"escalate"`.
With `escalate`, a new cloud worker starts on the cheapest enabled model of an
ordered ladder the user picks (models only, never inferred from names), and when
the lead marks a run's result as failed, the next dispatch for that task goes to
the next model up. The gateway's tier router already scores requests; S9 reuses
its scorer for the first rung instead of adding a second classifier. Host workers
keep their agent. Every rung passes `requireEnabledModel` and `assertPaidModel`.
  State: the rung belongs to a task, not to the worker thread. A task is the dispatch the lead
  made (its tool call id); a retry the lead makes for a failed run carries `retryOf` (the failed
  run's id) and takes `modelRung = failed run's rung + 1`, stored on the new run row. The
  worker's thread keeps its own `thread.model` and is never changed by escalation: a run
  overrides the model for itself only, so a queued dispatch for another task, or a message the
  user types into the worker's thread, runs on the worker's own model.
- Acceptance: a failed run's retry uses the next rung; the ladder never moves to a
  model the user did not list; a host worker is never moved; cost per completed
  task on a recorded set of tasks is lower than `own` with the same pass rate, or
  S9 is dropped.

## 7. Invariants crossed

- Claim-once on every redelivered dispatch (toolCallId or `worker-dispatch`),
  run claim and post-back (`resultPostedAt`).
- `chargeRound` once per cloud run, at start. Never for host runs.
- The 15-minute alarm cap: cloud runs on the jobs queue, and nothing waits on a
  scheduler job.
- The post-back wait is unchanged.
- Tools never widen. RLS: worker threads belong to the lead's owner, and reads go
  through the existing thread access checks.
- `.output()` and authz-matrix rows for the four new procedures, and for
  `stopWorker`.
- Claim-once on `stopWorker`'s `clientId`. Stopping is idempotent.

## 8. Risks

- **Cost loops.** A lead that keeps messaging a worker. Bounded by the rate
  limit, the 3-active cap and per-run charging.
- **Rate limit fit.** `subAgents/run:free` is 10 per hour per user, shared by
  delegations and every worker message, including ones the user types. Free-tier
  users chatting with a worker will hit it quickly. Measure after S2 before
  changing the limit.
- **Context growth** in long-lived workers. Uses the existing compaction path;
  the worker thread shows it.
- **Escalation through workers.** The subset rule, plus a test that dispatches a
  tool the lead lacks.
- **Attribution.** Every post-back carries the worker's name, as sub-agent
  results do today.

## 9. Open questions

1. **Do user-typed runs in a worker thread post back to the lead?**
   Recommendation: no. The user is talking to the worker directly; the lead hears
   only what it dispatched.
2. **Can the user create a worker without a lead dispatch?** Recommendation: yes,
   with the same caps (`createWorker`).
3. **Worker model.** Recommendation: the worker keeps its own thread `model`. The
   picker in the worker thread changes only that worker.
4. **Tell the lead about a cancelled run?** Today no. Recommendation: post a
   one-line "stopped" note for runs the lead dispatched, since the lead may be
   waiting on them, and nothing for runs the user typed.
5. **Where the dispatch policy lives.** Recommendation: an optional field on the
   lead thread (§4 Dispatch policy), with no new table.
