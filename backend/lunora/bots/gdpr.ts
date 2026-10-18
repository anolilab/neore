/**
 * The bots module's erasure for account deletion, called from
 * `gdpr/steps/residual-deletion-steps.ts#deleteUserIntegrations` after triggers.
 * A bot is a single row; its routines, threads and memories are erased by their
 * own modules (or keep a dangling `botId`, which readers ignore).
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

export const eraseBotsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const bots = await ctx.db
        .query("bots")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    // One delete at a time: every write to a table in `lib/audit-triggers.ts` fires a trigger.
    for (const bot of bots) {
        await ctx.db.delete(bot._id);
    }

    return { hasMore: full(bots) };
};

/** The user's bots for the GDPR export (`gdpr/workflows/export-workflow.ts`). */
export const collectBotsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ bots: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const bots = await ctx.db
            .query("bots")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH);

        return { bots };
    });
