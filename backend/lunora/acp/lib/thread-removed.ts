import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { endHostStream } from "../../chat/streaming/persistent/host";
import { isWorkerThread } from "../../sub-agents/worker-thread";
import { LIVE_STREAM_BATCH, sendHostCancel, settleWorkerRun } from "./finish";
import { isHostRunThread } from "./host-thread";
import { sessionOfThread } from "./sessions";

/**
 * A host thread was deleted (soft or hard): its live turn and its session go with it. Without this the turn stays
 * `running` until the reaper times it out, the desktop keeps posting into a thread nobody can open, and the session
 * reads as live.
 *
 * The turn ends without a reply (the thread is going away, and `saveHostReply` would only add a row for the delete
 * to catch), its host is asked to cancel while the session still counts as live (a cancel is refused for an ended
 * one), and then the session is ended. The row stays as the tombstone `session_open` reads to tell the desktop the
 * session is over: with it gone, a redelivered open would make a new thread. Idempotent, so every delete path and a
 * paged hard delete may call it again.
 *
 * A soft delete can be undone (`restoreHostThread`); a hard delete cannot.
 */
export const endHostThread = async (ctx: MutationCtx, thread: Pick<Doc<"threads">, "_id" | "runner">, now: number): Promise<void> => {
    if (!isHostRunThread(thread)) {
        return;
    }

    // The line behind a worker's current run ends first, or the end of that run would start the next message here.
    if (await isWorkerThread(ctx, thread._id)) {
        const { cancelQueuedWorkerRuns } = await import("../../sub-agents/functions");

        await cancelQueuedWorkerRuns(ctx, thread._id);
    }

    for (;;) {
        const { page: live } = await ctx.db.persistentStreams.findMany({
            limit: LIVE_STREAM_BATCH,
            where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId: thread._id },
        });
        let ended = 0;

        for (const stream of live) {
            const wasLive = await endHostStream(ctx, stream, { reason: "stopped", status: "done" }, now);

            if (wasLive) {
                await sendHostCancel(ctx, stream, now);
                // A worker run waiting on this turn ends with the thread.
                await settleWorkerRun(ctx, stream, { kind: "cancelled" });
                ended += 1;
            }
        }

        if (live.length < LIVE_STREAM_BATCH || ended === 0) {
            break;
        }
    }

    const session = await sessionOfThread(ctx, thread._id);

    if (session && session.status !== "ended") {
        await ctx.db.patch(session._id, { status: "ended", updatedAt: now });
    }
};

/**
 * A soft-deleted host thread was restored (undo). The session the delete ended comes back `offline`: not live, but no
 * longer a tombstone, so a desktop that still holds the session posts its next turn into the thread again (a post
 * moves the status on) and a redelivered `session_open` is no longer told the session is over. Whether the host is
 * still there is not known here; a session the desktop had closed itself stays `offline` too, and nothing posts to
 * it. The turn the delete cut short stays ended. Idempotent.
 * A session of a device that was removed since stays ended.
 */
export const restoreHostThread = async (ctx: MutationCtx, thread: Pick<Doc<"threads">, "_id" | "runner">, now: number): Promise<void> => {
    if (!isHostRunThread(thread)) {
        return;
    }

    const session = await sessionOfThread(ctx, thread._id);

    // A revoked device is deleted, and its sessions stay ended: nothing is left to post.
    if (session?.status === "ended" && (await ctx.db.devices.findFirst({ where: { _id: session.deviceId } }))) {
        await ctx.db.patch(session._id, { status: "offline", updatedAt: now });
    }
};
