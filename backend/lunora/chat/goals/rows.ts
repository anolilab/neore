/**
 * The plain row-level writes of a goal, free of any procedure so a stop, a new
 * message or a failed run can end a goal inside its own transaction
 * (`chat/goals/internal.ts` holds the procedures).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
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
 * Ends every active goal of the thread but `except` (the one a message is starting). Returns whether one was ended. Plain function:
 * the stop mutation, `startGoal` and the run-failure path call it inside their own
 * transaction. A goal ended here never reviews or continues: the review job and
 * `recordGoalVerdict` both check the status.
 */
export const endActiveGoals = async (ctx: GoalCtx, threadId: Id<"threads">, reason: GoalStopReason, except?: Id<"threadGoals">): Promise<boolean> => {
    const active = await activeGoalsOf(ctx, threadId);
    const goals = active.filter((goal) => goal._id !== except);

    for (const goal of goals) {
        await stopGoalRow(ctx, goal, reason);
    }

    return goals.length > 0;
};
