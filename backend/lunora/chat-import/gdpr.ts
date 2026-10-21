/**
 * The chat-import module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts`). A plain function over the caller's `ctx`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

/** Import jobs the user started, batched. A failed job's kept file goes with its row. */
export const eraseImportJobsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const importJobs = await ctx.db
        .query("chatImportJobs")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .take(BATCH);

    await scheduleObjectDeletion(
        ctx,
        importJobs.map((j) => j.r2Key),
    );
    await Promise.all(importJobs.map((j) => ctx.db.delete(j._id)));

    return { hasMore: full(importJobs) };
};
