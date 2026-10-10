/**
 * The messenger module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). A plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

/** Messenger connections (their encrypted keys are removed earlier, by `deleteUserSettings`' sibling steps). */
export const eraseMessengerConnectionsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("messengerConnections")
        .withIndex("by_user_and_platform", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(rows) };
};
