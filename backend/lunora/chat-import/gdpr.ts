/**
 * The chat-import module's erasure for account deletion (called by
 * `gdpr/steps/deletion-steps.ts`). A plain function over the caller's `ctx`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { keptImportKeyFor } from "./restart";

/** Import jobs the user started, batched. A failed job's kept file goes with its row. */
export const eraseImportJobsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const importJobs = await ctx.db
        .query("chatImportJobs")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .take(BATCH);

    // A kept copy sits under a deterministic key even when the row no longer names it, so that key is scheduled too.
    await scheduleObjectDeletion(
        ctx,
        importJobs.flatMap((j) => [j.r2Key, keptImportKeyFor(userId, j._id)]),
    );
    await Promise.all(importJobs.map((j) => ctx.db.delete(j._id)));

    return { hasMore: full(importJobs) };
};
