/**
 * The usage record of a reply, from the rows a run saved: one record per reply (`repliesByOrder`), keyed on its first
 * reply row, so a run that paused and resumed counts once however many invocations wrote the reply.
 *
 * `afterRun` records through this at the end of a run, and so does a pause that never resumes (a stop, a superseded
 * run): the rows it saved before the pause must not be lost.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { type ReplySkill, repliesByOrder, replyUsageArgs, type SavedRowLike } from "../../usage/activity-logic";
import { scheduleReplyUsage } from "../../usage/schedule";

type Scheduler = Parameters<typeof scheduleReplyUsage>[0];

export const scheduleRepliesUsage = (
    scheduler: Scheduler,
    rows: ReadonlyArray<SavedRowLike>,
    options: { at: number; skill?: ReplySkill; timeZone?: string; userId: string },
): void => {
    for (const reply of repliesByOrder(rows)) {
        scheduleReplyUsage(scheduler, replyUsageArgs(reply, options));
    }
};

/**
 * Record the reply a paused run saved before its pause, for a pause that will never resume (a stop, a superseded run, the
 * expiry sweep). The rows are the reply's (`pausedRun`); the run that would have ended it records them itself, so a caller
 * clears `pausedRun` after this and records at most once.
 */
export const recordPausedRunUsage = async (ctx: MutationCtx, stream: Doc<"persistentStreams">): Promise<void> => {
    const paused = stream.pausedRun;

    if (!paused) {
        return;
    }

    const found = await Promise.all(paused.replyRowIds.map(async (id) => await ctx.db.get(id as Id<"messages">)));
    const docs = found.filter((row) => row !== null);
    // The stored `message` is the AI SDK's, wider than the usage record reads: only its role is.
    const rows = docs.map((row) => {
        return {
            _id: row._id,
            message: row.message as { role?: string } | null | undefined,
            order: row.order,
            providerMetadata: row.providerMetadata,
            usage: row.usage,
        };
    });

    scheduleRepliesUsage(ctx.scheduler as never, rows, {
        at: ctx.now,
        userId: stream.pause?.run.userId ?? stream.userId,
        ...(paused.skill && { skill: paused.skill }),
        ...(paused.timeZone && { timeZone: paused.timeZone }),
    });
};
