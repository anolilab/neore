/**
 * Retention for `toolApprovalRuns`. Each row snapshots a run's final system
 * prompt — personalisation, memory and project text — so it must not outlive
 * its purpose:
 *
 * - with its thread: `deleteToolApprovalRunsForThread`, called from the
 *   thread hard-delete path (`agent/threads.ts`);
 * - resolved rows one day after they were answered;
 * - pending rows seven days after the run paused (an approval nobody answered).
 *
 * `purgeExpiredToolApprovalRuns` runs on the existing one-minute stream-cleanup
 * cron (`chat/streaming/persistent/crons.ts`), one bounded batch per status per
 * tick.
 *
 * Shards: the table is `.shardBy("userId")`, and a cron runs on `__root__` only.
 * It reaches these rows today because nothing routes by user shard — the web
 * client sends no `shardKey`, `/chat/start` and its scheduled run use the
 * default shard, and so every write here lands in the root DO (the same reason
 * `persistentStreams`, also `.shardBy("userId")`, is reachable by its root cron).
 * `purgeExpiredToolApprovalRunsForUser` is the shard-local backstop for the day
 * that changes, and `claimToolApproval` refuses an expired row either way. The
 * unit harness is one database, so it cannot tell shards apart.
 */
import type { MutationCtx } from "../../_generated/server";

export const RESOLVED_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_APPROVAL_TTL_MS = 7 * RESOLVED_APPROVAL_TTL_MS;

const PURGE_BATCH = 100;

export const deleteToolApprovalRunsForThread = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<number> => {
    const rows = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect();

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return rows.length;
};

export const purgeExpiredToolApprovalRuns = async (ctx: Pick<MutationCtx, "db">, now: number): Promise<number> => {
    const [pending, approved, denied] = await Promise.all([
        ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_status_createdAt", (q) => q.eq("status", "pending").lt("createdAt", now - PENDING_APPROVAL_TTL_MS))
            .take(PURGE_BATCH),
        ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_status_resolvedAt", (q) => q.eq("status", "approved").lt("resolvedAt", now - RESOLVED_APPROVAL_TTL_MS))
            .take(PURGE_BATCH),
        ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_status_resolvedAt", (q) => q.eq("status", "denied").lt("resolvedAt", now - RESOLVED_APPROVAL_TTL_MS))
            .take(PURGE_BATCH),
    ]);

    const expired = [...pending, ...approved, ...denied];

    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));

    return expired.length;
};

/** Has this row outlived its retention? Pending rows by age, resolved rows by resolution time. */
export const isToolApprovalRunExpired = (row: { createdAt: number; resolvedAt?: number; status: string }, now: number): boolean =>
    row.status === "pending" ? row.createdAt < now - PENDING_APPROVAL_TTL_MS : (row.resolvedAt ?? row.createdAt) < now - RESOLVED_APPROVAL_TTL_MS;

/**
 * Shard-local sweep of one user's expired rows, run whenever that user records
 * new snapshots. It executes in whichever Durable Object holds the user's rows,
 * so retention does not depend on the cron's shard being the same one — today
 * every call path lands on `__root__`, but if RPCs ever start routing by the
 * `userId` shard key, the root-shard cron would stop seeing these rows and this
 * sweep would keep working.
 */
export const purgeExpiredToolApprovalRunsForUser = async (ctx: Pick<MutationCtx, "db">, userId: string, now: number): Promise<number> => {
    const rows = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_userId_status_createdAt", (q) => q.eq("userId", userId))
        .take(PURGE_BATCH);
    const expired = rows.filter((row) => isToolApprovalRunExpired(row, now));

    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));

    return expired.length;
};
