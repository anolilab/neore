import { internalMutation } from "../../../_generated/server";
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
