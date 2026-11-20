/**
 * The bots module's erasure for account deletion, called from
 * `gdpr/steps/residual-deletion-steps.ts#deleteUserIntegrations` after triggers.
 * A bot is a single row; its routines, threads and memories are erased by their
 * own modules (or keep a dangling `botId`, which readers ignore).
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { retireBotComputersIn } from "../sandbox/functions";

export const eraseBotsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const bots = await ctx.db
        .query("bots")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    // One delete at a time: every write to a table in `lib/audit-triggers.ts` fires a trigger.
    for (const bot of bots) {
        // The kill is scheduled with the sandbox id, so it still runs after the session row is erased.
        await retireBotComputersIn(ctx, bot._id);
        await ctx.db.delete("bots", bot._id);
    }

    // `botOwners` is global: its rows of this user are erased with the bots, deleted or not. Primary: a lagging replica
    // could miss a fresh row and let a short page report the erasure done.
    const owners = await ctx.db.botOwners.findMany({ consistency: "primary", limit: BATCH, where: { ownerId: userId } });

    for (const row of owners.page) {
        await ctx.db.delete("botOwners", row._id);
    }

    return { hasMore: full(bots) || full(owners.page) };
};

/** The user's bots for the GDPR export (`gdpr/workflows/export-workflow.ts`). */
export const collectBotsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ botOwners: v.array(v.any()), bots: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const bots = await ctx.db
            .query("bots")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH);
        // The owner records outlive deleted bots (`botOwners`), so they are the user's data too. Primary, as for the erasure.
        const owners = await ctx.db.botOwners.findMany({ consistency: "primary", where: { ownerId: userId } });

        return { botOwners: owners.page, bots };
    });
