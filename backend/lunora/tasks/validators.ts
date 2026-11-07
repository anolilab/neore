/**
 * The task domain's column validators, declared once: `schema.ts` builds the
 * `goals` / `tasks` / `taskRuns` tables from them and the procedures reuse them
 * for their arguments and outputs, so a new status cannot reach one and not the other.
 *
 * Inline `v.union(...)` literals rather than derived from `TASK_STATUSES`:
 * codegen resolves an inline validator expression, not one built by a call.
 */
import { v } from "lunorash/server";

export const vTaskStatus = v.union(
    v.literal("todo"),
    v.literal("queued"),
    v.literal("running"),
    v.literal("needs_review"),
    v.literal("done"),
    v.literal("failed"),
    v.literal("blocked"),
);

export const vGoalStatus = v.union(v.literal("active"), v.literal("completed"), v.literal("archived"));

export const vTaskRunOrigin = v.union(v.literal("manual"), v.literal("dependency"), v.literal("schedule"), v.literal("retry"), v.literal("repair"));

export const vTaskRunStatus = v.union(v.literal("running"), v.literal("passed"), v.literal("failed"), v.literal("error"), v.literal("cancelled"));

export const vVerdict = v.object({
    pass: v.boolean(),
    reasons: v.array(v.string()),
    repairInstructions: v.optional(v.string()),
});

/**
 * Why the sweep let a recurring task's slot pass without a run: the previous run
 * was still queued or running, its result waits on a review, or it waits on its
 * dependencies.
 */
export const vTaskSkipReason = v.union(v.literal("still_running"), v.literal("awaiting_review"), v.literal("blocked"));

/**
 * Where a recurring task's run goes: a new thread each run (the default, also
 * when unset), appended to the last run's thread, or into that thread after a
 * divider with no earlier turns sent to the model (`tasks/AGENTS.md`).
 */
export const vTaskRunDestination = v.union(v.literal("new_thread"), v.literal("continue_thread"), v.literal("fresh_context"));

/**
 * Why the last run did not go where the task says (`tasks/AGENTS.md`): its project is one the owner can no
 * longer file into (the run filed nowhere), or the kept thread is locked, busy with a reply, or no longer
 * usable (moved, deleted), so the run started a new thread.
 */
export const vTaskRunNoticeReason = v.union(
    v.literal("project_unwritable"),
    v.literal("thread_locked"),
    v.literal("thread_busy"),
    v.literal("thread_shared"),
    v.literal("thread_unavailable"),
);
