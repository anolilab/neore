# TASKS — AGENT NOTES

The rules for working in `backend/lunora/tasks/`: agent-run tasks with a verifier, their repair rounds, and
recurring tasks. State machine and idempotency are explained at the top of `internal.ts`.

## RUNNING A ROUND

- Every hand-off is a mutation: `claimRound` inserts the `taskRuns` row and charges the daily limits in one
  transaction; `completeRound` finishes only a run still `running` whose cycle is still the task's. A late or
  redelivered result is a no-op (`cancelled`), never a second run.
- Rounds go on the jobs queue (`enqueueJob`), not the scheduler.

## RECURRING TASKS: MISSED AND OVERLAPPING SLOTS

- The sweep is `checkDueTasks`, on the shard's minute tick and on housekeeping.
- **One look per slot.** The sweep advances `nextRunAt` before deciding, so a task that cannot start is not
  re-examined every minute. Keep it that way.
- **Next slot from `now`, never from the slot being served** (`nextRecurrenceAt(cron, now)`). After the sweep was
  down for several slots, the first sweep starts ONE catch-up run and moves on to the next future slot. Never
  replay the missed slots as a burst, and never add a "missed N slots" queue.
- **Stale rounds are failed BEFORE the due scan.** A round that went silent during an outage is failed first, so
  its slot starts the catch-up instead of being skipped as "still running".
- **A slot a task cannot run now is recorded, not dropped.** `lastSkippedAt` and `lastSkipReason` on the task:
  `still_running` (queued or running), `awaiting_review` (needs review), `blocked` (already blocked, or found
  blocked by `startTask` at this slot; it runs once its dependencies finish). The task view shows it while the task
  repeats (`apps/web/src/features/tasks/components/task-skipped-slot.tsx`). A skipped slot is NOT run later.
- **Only real slots are recorded** (`latestSlotAtOrBefore`): the latest slot at or before the sweep on the
  scheduler's own 15-minute grid, never before `createdAt`, at most a week back. A schedule that matches no date
  records no skip, and costs one cron search, so a skipped task never holds up the rest of the batch.
- **A skip never touches `updatedAt`.** The stale-round check reads `updatedAt` as the run's last sign of life;
  bumping it on a skip would keep a dead run alive forever.
- Fairness: at most `MAX_RECURRENCES_PER_USER_PER_SWEEP` per user and `SWEEP_BATCH` per sweep; the rest keep
  their `nextRunAt` and are the oldest-due next minute.

## A FAILED RUN IS NEVER RECORDED AS SUCCEEDED

- Three writers fail a run, and each writes `failedTaskPatch` (`status: "failed"`, `lastError`, no
  `resultSummary`): `refuseRound` (the claim refused the round), `completeRound` on an `error` outcome, and the
  stale sweep (`failStaleTask` in `checkDueTasks`). An earlier run's result would otherwise read as the outcome of
  the run that failed; that answer stays on its own `taskRuns` row.
- `reviewTask` rejecting a result is the one other writer of `failed`. It patches `lastError: "Rejected in review"`
  and keeps `resultSummary`, because the summary is the result the person rejected.
- The stale sweep also sends an inbox failure: a catch-up started in the same sweep clears `lastError`, and a
  round that never started has no run row.
- `updateTask` clears the recorded skip when the schedule is removed or changed.
- A run is `passed` only on a verifier pass. An answer the verifier could not check is an `error` run and a
  `needs_review` task; an empty answer is an error.
- Only `completeRound` reaching `done` sends a success notification (`notifyTaskRound`); an error, a
  `needs_review` result and the stale sweep send a failure, and a decision in `reviewTask` sends none.

## WHERE A RUN GOES, AND ITS EFFORT

- `tasks.runDestination` (recurring tasks only; unset = `new_thread`): `new_thread` each run, `continue_thread`
  (append to `lastRunThreadId`), or `fresh_context` (same thread, a divider, no earlier turns sent).
- `claimRound` decides with `pickRunThread`: it continues `lastRunThreadId` only while that thread is the owner's,
  not deleted, temporary, locked or host-run, not busy with a reply, and in the task's `projectId`. Anything else starts a new thread, so
  moving the task to another project (or the thread out of it) starts a new thread. Never clear
  `lastRunThreadId` to force this; the run history links to it.
- `fresh_context` sends no earlier turns on every round of the cycle, and only round 0 writes the divider. The claim
  carries the attempt being repaired (`repair.previousAnswer`); the runner drops it from the prompt only when the round
  really continues a thread with its history (`repairFor`), after its last re-check. A goal's later rounds inside one run read that run's own turns.
- The project takes WRITE access (`writableProject`: the owner's own, or an organization project nobody owns;
  the rule of moving a thread into a project), checked when the task is saved and again by `resolveRunPlace` at
  every claim. Saving a project without it is refused; the task's own project that lost it is dropped on edit.
  At a run, it files nowhere and records `lastRunNotice: project_unwritable`.
- A locked chat is never written by a run (no unlock proof): choosing to keep a thread whose chat is locked is
  refused at save; at a run `pickRunThread` starts a new thread (`thread_locked`).
- A live chat reply (a `pending`/`streaming` stream: the thread's run lock) or a chat waiting on its owner
  (`awaitingInput`: a newer turn would make the pending answer stale) means a new thread (`thread_busy`).
- A chat shared by public link is never continued (the link shows the live path): `thread_shared`, hand over.
  The runner re-checks with `runThreadProblem` right before its first write and records the precise reason; a
  deleted kept thread is `thread_unavailable`. A chat send DURING a task run is not held back: that needs the run
  to own a stream (#565).
- `lastRunNotice` is cleared by the next run that went where the task says; the task view shows it. Only round 0
  writes it, and a late action writes it only for the current cycle (`recordRunNotice`).
- A passing fallback (`thread_locked`, `thread_busy`: `isPassingFallback`) keeps `lastRunThreadId` on the old
  thread (`completeRound`'s `keepLastThread`); a moved or deleted thread hands over to the new one.
- Filing stays best-effort (`.catch` + log): a project deleted mid-run must not fail a paid run.
- The run gets the project's `context` as `PROJECT CONTEXT:` in `system`, framed as `chat/lib/agent-run.ts` does.
  The runner re-reads project and context with `runProjectFor` right before it uses them (access can go in between).
- A repair round continues the thread its cycle's previous round ran in (`resolveRunPlace`), which after a passing
  fallback is not `lastRunThreadId`.
- The divider is `agent/context-reset.ts` (`appendContextReset`): a `system` row with no text and
  `providerMetadata.neoreContextReset`, written through `addMessagesHandler` with the displayed leaf as its parent. Models never see it
  (`docsToModelMessages` drops empty rows); `toUIMessages` turns it into a `data-contextReset` part. It is written
  before the run, and the run passes `contextOptions: { recentMessages: 0 }` (`runHeadlessAgent`'s
  `freshContext`), which also skips the thread summary. Do not use `statelessMode` for this: it skips the order
  bookkeeping.
- A new run thread is filed in `tasks.projectId` from `onThread`, so a run that fails is filed too. A deleted
  project leaves the thread unfiled rather than failing the run.
- `tasks.reasoningEffort` is on the chat's 0-100 scale (the effort slider) and wins over the skill's. A coding-agent
  task takes none.
