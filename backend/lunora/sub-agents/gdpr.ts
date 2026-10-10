/**
 * The sub-agents module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). A plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";

/**
 * Sub-agent runs carry the delegated task and the child's answer. A run still
 * in flight finds its row gone and posts nothing.
 */
export const eraseSubAgentRunsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_user_and_createdAt", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(
        rows.map(async (row) => {
            await ctx.db.delete(row._id).catch((error: unknown) => {
                gdprLogger.error(`Failed to delete subAgentRuns ${row._id}:`, error);
            });
        }),
    );

    return { hasMore: full(rows) };
};

/**
 * Retention (`gdpr/retention.ts`): finished runs (`succeeded` / `failed`) created
 * before `cutoff`, oldest first, at most `limit`. Returns how many were deleted.
 */
export const pruneSubAgentRunsBefore = async (ctx: MutationCtx, cutoff: number, limit: number): Promise<number> => {
    const { page: runs } = await ctx.db.subAgentRuns.findMany({
        limit,
        orderBy: [{ createdAt: "asc" }],
        where: { createdAt: { lt: cutoff }, status: { in: ["succeeded", "failed"] } },
    });

    await Promise.all(runs.map(async (row) => await ctx.db.delete(row._id)));

    return runs.length;
};
