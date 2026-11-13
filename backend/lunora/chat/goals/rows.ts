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
    await ctx.db.patch("threadGoals", goal._id, { endedAt: ctx.now, status: "stopped", stopReason: reason, updatedAt: ctx.now });
};

/** Where a prompt sits in save order. */
export type PromptPosition = Pick<Doc<"messages">, "_creationTime" | "_id" | "order" | "stepOrder">;

/**
 * Negative when `left` was saved before `right`. Creation time first; two prompts saved in the same millisecond fall
 * back to their place in the thread (a send that branches from no prompt is saved after the thread's last row), then to
 * their ids, so two different prompts never compare equal.
 */
export const comparePromptPositions = (left: PromptPosition, right: PromptPosition): number =>
    left._creationTime - right._creationTime || left.order - right.order || left.stepOrder - right.stepOrder || left._id.localeCompare(right._id, "en");

/** Whether the goal's starting prompt was saved before `prompt`. A goal whose prompt is gone counts as older. */
const startedBefore = async (ctx: Pick<QueryCtx, "db">, goal: Doc<"threadGoals">, prompt: PromptPosition): Promise<boolean> => {
    const start = await ctx.db.get("messages", goal.startMessageId as Id<"messages">);

    return start === null || comparePromptPositions(start, prompt) < 0;
};

/**
 * Ends every active goal of the thread, or with `before` only the goals whose starting prompt was saved before that
 * prompt, whenever the goal itself started. Returns whether one was ended. Plain function: the stop mutation,
 * `startGoal` and the run-failure path call it inside their own transaction. A goal ended here never reviews or
 * continues: the review job and `recordGoalVerdict` both check the status.
 */
export const endActiveGoals = async (
    ctx: GoalCtx,
    threadId: Id<"threads">,
    reason: GoalStopReason,
    { before }: { before?: PromptPosition } = {},
): Promise<boolean> => {
    const active = await activeGoalsOf(ctx, threadId);
    const goals = [];

    for (const goal of active) {
        if (before === undefined || (await startedBefore(ctx, goal, before))) {
            goals.push(goal);
        }
    }

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
 * ends it, or the sweep that reaps many. `failed` says the goal ended in an error, so a snoozed thread
 * wakes (`patchThread`).
 */
export const giveThreadBack = async (ctx: GoalCtx, threadId: Id<"threads">, { failed = false }: { failed?: boolean } = {}): Promise<void> => {
    if (await ctx.db.get("threads", threadId)) {
        await patchThread(ctx.db, threadId, { status: "active", updatedAt: ctx.now }, { failed });
    }
};

/** Removes every goal of a thread being deleted. Idempotent: the delete chain re-runs it per batch. */
export const deleteGoalsForThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<void> => {
    const goals = await ctx.db
        .query("threadGoals")
        .withIndex("by_thread_and_status", (q) => q.eq("threadId", threadId))
        .collect();

    for (const goal of goals) {
        await ctx.db.delete("threadGoals", goal._id);
    }
};

/** The prompt row a run answers: named directly, or read off the run's stream. */
export const runPromptId = async (ctx: Pick<QueryCtx, "db">, run: { messageId?: string; streamId?: Id<"persistentStreams"> }): Promise<string | undefined> => {
    if (run.messageId !== undefined || run.streamId === undefined) {
        return run.messageId;
    }

    const stream = await ctx.db.get("persistentStreams", run.streamId);

    if (!stream) {
        return undefined;
    }

    // An approval continuation's stream is keyed on the approval id; the paused run's prompt is in its snapshot.
    const approval = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_approvalId", (q) => q.eq("approvalId", stream.messageId))
        .first();

    return approval?.config.promptMessageId ?? stream.messageId;
};

/** Ends only the goal whose current round the run on `streamId` answers: a goal the stream does not run is left alone. */
export const endGoalsOfStream = async (ctx: GoalCtx, threadId: Id<"threads">, streamId: Id<"persistentStreams">, reason: GoalStopReason): Promise<boolean> => {
    const promptId = await runPromptId(ctx, { streamId });
    const active = await activeGoalsOf(ctx, threadId);
    const own = active.filter((goal) => promptId !== undefined && goal.promptMessageId === promptId);

    for (const goal of own) {
        await stopGoalRow(ctx, goal, reason);
    }

    return own.length > 0;
};
