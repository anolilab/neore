/**
 * What a host guide does when its coding-agent turn ends, however it ends (the host's `turn_end`, Stop, the reaper, a
 * revoked device, a deleted thread: `acp/lib/finish.ts#endHostTurn` calls this once for each). A plain function over
 * `ctx.db`, so the write stays in the finishing mutation's transaction.
 *
 * Only a turn that FINISHED has an answer to read, and reading it needs the host again (the agent's line numbers are
 * checked against the diff), which a mutation cannot do: the rest is `guide-host.ts#finalizeHostGuide`, on the queue.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import type { HostReplyReason } from "../acp/lib/reply";
import { enqueueJob } from "../lib/job-queue";
import { markGuideFailed } from "./guide-internal";

/** Whether the turn ended because somebody stopped it, rather than because it went wrong. */
const WAS_STOPPED: ReadonlySet<HostReplyReason> = new Set(["cancelled", "stopped"]);

export const settleHostGuide = async (
    ctx: MutationCtx,
    stream: Pick<Doc<"persistentStreams">, "_id" | "threadId" | "userId">,
    reason: HostReplyReason,
): Promise<void> => {
    const guide = await ctx.db.pullRequestGuides.findFirst({ where: { threadId: stream.threadId, userId: stream.userId } });

    if (!guide || guide.status !== "generating") {
        return;
    }

    if (reason === "finished") {
        // The stream id is the whole payload: the answer is read off its chunks by the job, not carried through the queue.
        await enqueueJob(
            internal.source_control.guide_host.finalizeHostGuide,
            { guideId: guide._id, streamId: stream._id, userId: stream.userId },
            { shardKey: stream.userId },
        );

        return;
    }

    await markGuideFailed(ctx, stream.userId, guide._id, WAS_STOPPED.has(reason) ? "no_answer" : "host_error");
};
