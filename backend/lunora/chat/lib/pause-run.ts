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

/**
 * Pause `streamId`'s run when `error` is a provider rate limit the caps allow waiting out. Returns whether it paused;
 * on `false` the caller fails the run as it always did, with the provider's message.
 *
 * - `settle` lets the model call finish winding down first: the agent marks the rejected step's placeholder row failed
 *   when it sees the error, and the pause removes that row.
 * - `from` is the row the rejected step continues from (the last row the run saved, else its prompt).
 * - The decision uses the structured `rateLimit` field only; no message text is read.
 */
export const pauseOnRateLimit = async (
    ctx: Pick<ActionCtx, "runMutation">,
    args: { error: unknown; from: string; run: RunStreamingArgs; settle: () => Promise<unknown>; streamId: string },
): Promise<boolean> => {
    const rateLimit = rateLimitOf(args.error);

    if (!rateLimit) {
        return false;
    }

    await args.settle();

    const outcome = await ctx.runMutation(internal.chat.streaming.persistent.library.pauseRunForRateLimit, {
        from: args.from,
        ...(rateLimit.provider !== undefined && { provider: rateLimit.provider }),
        ...(rateLimit.retryAt !== undefined && { retryAt: rateLimit.retryAt }),
        run: args.run,
        status: rateLimit.status,
        streamId: args.streamId as Id<"persistentStreams">,
    });

    if (!outcome.paused) {
        streamLogger.warn(`[BgAgent] Stream ${args.streamId} hit a provider rate limit and does not pause: ${outcome.reason}`);

        return false;
    }

    streamLogger.info(`[BgAgent] Stream ${args.streamId} paused on a provider rate limit until ${new Date(outcome.retryAt ?? 0).toISOString()}`);

    return true;
};
