/**
 * Erasure of the saas tables a deleted account owns (`gdpr/steps/`). A plain
 * function over the caller's `ctx`, so the write stays in the caller's
 * transaction.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, full, type BatchResult } from "../gdpr/batch";

/** One batch of the user's gateway notifications (`gatewayNotifications`). */
export const eraseGatewayNotificationsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("gatewayNotifications")
        .withIndex("by_userId_isRead", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(rows) };
};
