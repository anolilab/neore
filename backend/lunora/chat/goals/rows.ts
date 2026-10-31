/**
 * The plain row-level writes of a goal, free of any procedure so a stop, a new
 * message or a failed run can end a goal inside its own transaction
 * (`chat/goals/internal.ts` holds the procedures).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { patchThread } from "../../agent/table-writes";
import type { GoalStopReason } from "./shared";

export type GoalCtx = Pick<MutationCtx, "db" | "now">;

export const activeGoalsOf = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<Doc<"threadGoals">[]> =>
    await ctx.db
        .query("threadGoals")
        .withIndex("by_thread_and_status", (q) => q.eq("threadId", threadId).eq("status", "active"))
        .take(10);

export const stopGoalRow = async (ctx: GoalCtx, goal: Doc<"threadGoals">, reason: GoalStopReason): Promise<void> => {
    await ctx.db.patch(goal._id, { endedAt: ctx.now, status: "stopped", stopReason: reason, updatedAt: ctx.now });
};

/**
 * Ends every active goal of the thread. Returns whether one was ended. Plain function:
 * the stop mutation, `startGoal` and the run-failure path call it inside their own
 * transaction. A goal ended here never reviews or continues: the review job and
 * `recordGoalVerdict` both check the status.
 */
export const endActiveGoals = async (ctx: GoalCtx, threadId: Id<"threads">, reason: GoalStopReason): Promise<boolean> => {
    const goals = await activeGoalsOf(ctx, threadId);

    for (const goal of goals) {
        await stopGoalRow(ctx, goal, reason);
    }

    return goals.length > 0;
};

/** Whether a run is queued (`pending`) or running (`streaming`) on the thread. */
export const hasLiveStream = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<boolean> => {
    for (const status of ["pending", "streaming"] as const) {
        const live = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", status))
            .first();

        if (live) {
            return true;
        }
    }

    return false;
};

/**
 * Gives a thread back to the user after a goal's run: `active` again. A thread that is gone (deleted
 * while a round was queued) is skipped, so one goal of a vanished thread never fails the write that
 * ends it, or the sweep that reaps many.
 */
export const giveThreadBack = async (ctx: GoalCtx, threadId: Id<"threads">): Promise<void> => {
    if (await ctx.db.get(threadId)) {
        await patchThread(ctx.db, threadId, { status: "active", updatedAt: ctx.now });
    }
};

/** Removes every goal of a thread being deleted. Idempotent: the delete chain re-runs it per batch. */
export const deleteGoalsForThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<void> => {
    const goals = await ctx.db
        .query("threadGoals")
        .withIndex("by_thread_and_status", (q) => q.eq("threadId", threadId))
        .collect();

    for (const goal of goals) {
        await ctx.db.delete(goal._id);
    }
};
