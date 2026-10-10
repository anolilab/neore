/**
 * The sandbox module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). A plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

/** Sandbox sessions with their command log. A session whose log is longer than one batch stays for the next round. */
export const eraseSandboxSessionsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const sessions = await ctx.db
        .query("sandboxSessions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    let hasMore = false;

    for (const session of sessions) {
        const actions = await ctx.db
            .query("sandboxActions")
            .withIndex("by_sessionId_timestamp", (q) => q.eq("sessionId", session._id))
            .take(BATCH);

        await Promise.all(actions.map((action) => ctx.db.delete(action._id)));

        if (full(actions)) {
            hasMore = true;
            continue;
        }

        await ctx.db.delete(session._id);
    }

    return { hasMore: hasMore || full(sessions) };
};
