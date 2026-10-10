/**
 * Erasure and retention of the usage tables (`usageDaily`, `usageReplies`,
 * `usageBackfill`), owned by the usage module.
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's
 * transaction. Typed ids only: an `Id<TableName>` would read as a write to
 * every table.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BATCH, full, type BatchResult } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";

/** Deletes a usage row that may already be gone (a retried round, or a dangling id). */
const deleteQuietly = async (ctx: MutationCtx, id: Id<"usageDaily"> | Id<"usageReplies"> | Id<"usageBackfill">, what: string): Promise<void> => {
    await ctx.db.delete(id).catch((error: unknown) => {
        gdprLogger.error(`Failed to delete ${what} ${id}:`, error);
    });
};

/**
 * One batch of the user's per-day rollup (`usageDaily`), the keys of the replies
 * it counted (`usageReplies`) and the backfill's position (`usageBackfill`).
 * `hasMore` while any batch came back full. A step still running finds its
 * backfill row gone and stops.
 */
export const eraseUsageForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [days, keys, backfills] = await Promise.all([
        ctx.db
            .query("usageDaily")
            .withIndex("by_user_date", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageReplies")
            .withIndex("by_user_reply", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageBackfill")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all([
        ...days.map(async (row) => await deleteQuietly(ctx, row._id, "usageDaily")),
        ...keys.map(async (row) => await deleteQuietly(ctx, row._id, "usageReplies")),
        ...backfills.map(async (row) => await deleteQuietly(ctx, row._id, "usageBackfill")),
    ]);

    return { hasMore: full(days) || full(keys) || full(backfills) };
};

/**
 * Retention (`gdpr/retention.ts`): one batch of `usageDaily` rows dated before
 * `cutoffDate` (YYYY-MM-DD). Returns how many were deleted.
 */
export const pruneUsageDaysBefore = async (ctx: MutationCtx, cutoffDate: string, limit: number): Promise<number> => {
    const { page: days } = await ctx.db.usageDaily.findMany({
        limit,
        orderBy: [{ date: "asc" }],
        where: { date: { lt: cutoffDate } },
    });

    await Promise.all(days.map(async (row) => await ctx.db.delete(row._id)));

    return days.length;
};
