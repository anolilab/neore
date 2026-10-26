/**
 * The triggers module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). A plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { deleteDeliveries } from "./deliveries";

/** Triggers with their run history and webhook delivery records. A trigger with more of either than one batch stays for the next round. */
export const eraseTriggersForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const triggers = await ctx.db
        .query("triggers")
        .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
        .take(BATCH);

    let hasMore = false;

    for (const trigger of triggers) {
        const executions = await ctx.db
            .query("triggerExecutions")
            .withIndex("by_triggerId_startedAt", (q) => q.eq("triggerId", trigger._id))
            .take(BATCH);

        await Promise.all(executions.map((row) => ctx.db.delete(row._id)));

        const moreDeliveries = await deleteDeliveries(ctx, trigger._id, BATCH);

        if (moreDeliveries || full(executions)) {
            hasMore = true;
            continue;
        }

        await ctx.db.delete(trigger._id);
    }

    return { hasMore: hasMore || full(triggers) };
};
