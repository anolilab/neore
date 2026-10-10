/**
 * The system-prompts module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). A plain function over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

/** The user's saved system-prompt presets, batched. */
export const eraseSystemPromptPresetsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const presets = await ctx.db
        .query("systemPromptPresets")
        .withIndex("by_userId_modelId", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(presets.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(presets) };
};
