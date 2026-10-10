import { internalMutation } from "../../../_generated/server";
import { purgeExpiredToolApprovalRuns } from "../../lib/tool-approval-cleanup";

const BATCH_SIZE = 100;

export const cleanupExpiredStreams = internalMutation.input({}).mutation(async ({ ctx }) => {
    const now = ctx.now;

    // Query all streams that have expired, regardless of status
    // This is more efficient than checking status + calculating expiration
    const expiredStreams = await ctx.db
        .query("persistentStreams")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .filter((document) => document.status === "pending" || document.status === "streaming")
        .take(BATCH_SIZE);

    for (const stream of expiredStreams) {
        console.log("Cleaning up expired stream", stream._id, {
            expiresAt: new Date(stream.expiresAt).toISOString(),
            status: stream.status,
        });
        await ctx.db.patch(stream._id, { status: "timeout" });
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
