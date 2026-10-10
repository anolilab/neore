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
