import type { Id } from "../../../_generated/dataModel";
import { internalMutation } from "../../../_generated/server";
import { expireHostStream } from "../../../acp/lib/reap";
import { patchThread } from "../../../agent/table-writes";
import { patchRow } from "../../../lib/patch";
import { recordPausedRunUsage } from "../../lib/pause-usage";
import { type SteerEntry, withoutQueuedText } from "../../lib/steer-queue";
import { purgeExpiredToolApprovalRuns } from "../../lib/tool-approval-cleanup";

const BATCH_SIZE = 100;

export const cleanupExpiredStreams = internalMutation.input({}).mutation(async ({ ctx }) => {
    const { now } = ctx;

    // Only pending and streaming streams expire into `timeout`. Filter them in SQL, so finished rows (never deleted)
    // are not read.
    const { page: expiredStreams } = await ctx.db.persistentStreams.findMany({
        limit: BATCH_SIZE,
        where: { expiresAt: { lt: now }, status: { in: ["pending", "streaming"] } },
    });

    for (const stream of expiredStreams) {
        // A coding agent's turn is reaped by `acp/lib/reap.ts` (which also tells its host to cancel); this sweep
        // is only the backstop for when the shard tick has not reached it.
        if (stream.producer === "host") {
            await expireHostStream(ctx, stream, now);

            continue;
        }

        console.log("Cleaning up expired stream", stream._id, {
            expiresAt: new Date(stream.expiresAt).toISOString(),
            status: stream.status,
        });

        const steers = withoutQueuedText(stream.steers as SteerEntry[] | undefined);

        // A run that was waiting out a rate limit and never resumed (its resume was lost and nobody asked again) has no
        // run left to record the steps it finished: do it here, once.
        const waiting = stream.pause !== undefined && stream.pausedRun !== undefined;

        if (waiting) {
            await recordPausedRunUsage(ctx, stream);
        }

        await patchRow(ctx.db, stream, { status: "timeout", ...(steers && { steers }), ...(waiting && { pausedRun: undefined }) });

        // A run that died without reaching `failRun` (evicted, or a dropped redelivery)
        // leaves its thread `running`; nothing else resets it. A newer live stream on the
        // thread means another run owns that status.
        const threadId = stream.threadId as Id<"threads">;
        const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });
        const live = await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId } });
        // An edit streams through `streamingMessages` instead, and it holds the same running status.
        const liveEdit = await ctx.db
            .query("streamingMessages")
            .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", threadId).eq("stateKind", "streaming"))
            .take(1);

        if (thread?.status === "running" && !live && liveEdit.length === 0) {
            await patchThread(ctx.db, thread._id, { status: "active", updatedAt: now });
        }
    }

    if (expiredStreams.length > 0) {
        console.log(`Cleaned up ${expiredStreams.length} expired streams`);
    }

    // Hosted here rather than on a cron of its own: approval snapshots are run
    // artifacts like the streams above, and one bounded batch a minute keeps up.
    const purgedApprovals = await purgeExpiredToolApprovalRuns(ctx, now);

    if (purgedApprovals > 0) {
        console.log(`Purged ${purgedApprovals} expired tool-approval snapshot(s)`);
    }
});
