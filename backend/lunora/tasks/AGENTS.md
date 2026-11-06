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
