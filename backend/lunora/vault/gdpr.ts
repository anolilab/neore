/**
 * The vault module's erasure for account deletion (`gdpr/steps/deletion-steps.ts`
 * calls this). A plain function over the caller's `ctx`; batching follows
 * `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

/**
 * The user's vault: files (with their R2 objects), then folders once no file is
 * left. At most {@link BATCH} rows per call; `hasMore` while any may remain —
 * the workflow drains it.
 */
export const eraseVaultForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const files = await ctx.db
        .query("files")
        .withIndex("by_user_and_folder", (q) => q.eq("userId", userId))
        .take(BATCH);

    if (files.length > 0) {
        await scheduleObjectDeletion(
            ctx,
            files.map((file) => file.key),
        ).catch((error: unknown) => {
            gdprLogger.error(`Failed to schedule deletion of ${String(files.length)} vault objects from R2:`, error);
        });

        // One at a time: `files` carries audit triggers, and a whole batch
        // deleted concurrently counts as one nested trigger chain (the
        // engine refuses past 50 levels).
        for (const file of files) {
            await ctx.db.delete(file._id);
        }

        return { hasMore: true };
    }

    const folders = await ctx.db
        .query("folders")
        .withIndex("by_user_and_parent", (q) => q.eq("userId", userId))
        .take(BATCH);

    for (const folder of folders) {
        await ctx.db.delete(folder._id);
    }

    return { hasMore: folders.length >= BATCH };
};
