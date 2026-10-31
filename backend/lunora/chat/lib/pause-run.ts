/**
 * The run side of pausing on a provider rate limit (`rate-limit-pause.ts`): the action that hit the
 * limit asks its stream to pause (`pauseRunForRateLimit`), which also queues the resume.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { streamLogger } from "../../lib/logger";
import { rateLimitOf } from "./rate-limit-pause";
import type { RunStreamingArgs } from "./streaming-run-args";

/** What the run has done, read once its model call has wound down: where the rejected step continues from, and what to carry over. */
export interface PauseProgress {
    /** The row the rejected step continues from (the last row this run saved, else its prompt): the resume streams from it. */
    from: string;
    /** The row the rejected step opened before its call, if any: the one row the pause removes. */
    placeholderId?: string;
    /** The rows this invocation saved. */
    replyRowIds: string[];
    /** The steps this invocation finished. */
    stepsUsed: number;
}

/**
 * Pause `streamId`'s run when `error` is a provider rate limit the caps allow waiting out. Returns whether it paused;
 * on `false` the caller fails the run as it always did, with the provider's message.
 *
 * - `settle` lets the model call finish winding down first: the agent marks the rejected step's placeholder row failed
 *   when it sees the error, and a step save already under way lands. `progress` is read after it, so it sees those.
 * - The decision uses the structured `rateLimit` field only; no message text is read.
 */
export const pauseOnRateLimit = async (
    ctx: Pick<ActionCtx, "runMutation">,
    args: {
        error: unknown;
        progress: () => PauseProgress;
        /** What the run's usage record needs, so a pause that never resumes can still record it. */
        reply: { skill?: { id?: string; name: string }; timeZone?: string };
        run: RunStreamingArgs;
        settle: () => Promise<unknown>;
        streamId: string;
    },
): Promise<boolean> => {
    const rateLimit = rateLimitOf(args.error);

    if (!rateLimit) {
        return false;
    }

    await args.settle();

    const { from, placeholderId, replyRowIds, stepsUsed } = args.progress();
    const outcome = await ctx.runMutation(internal.chat.streaming.persistent.library.pauseRunForRateLimit, {
        from,
        ...(placeholderId !== undefined && { placeholderId }),
        ...(rateLimit.provider !== undefined && { provider: rateLimit.provider }),
        replyRowIds,
        ...(rateLimit.retryAt !== undefined && { retryAt: rateLimit.retryAt }),
        run: args.run,
        ...(args.reply.skill && { skill: args.reply.skill }),
        status: rateLimit.status,
        stepsUsed,
        streamId: args.streamId as Id<"persistentStreams">,
        ...(args.reply.timeZone && { timeZone: args.reply.timeZone }),
    });

    if (!outcome.paused) {
        streamLogger.warn(`[BgAgent] Stream ${args.streamId} hit a provider rate limit and does not pause: ${outcome.reason}`);

        return false;
    }

    streamLogger.info(`[BgAgent] Stream ${args.streamId} paused on a provider rate limit until ${new Date(outcome.retryAt ?? 0).toISOString()}`);

    return true;
};
