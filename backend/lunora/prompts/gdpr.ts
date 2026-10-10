/**
 * The prompts module's erasure for account deletion (`gdpr/steps/deletion-steps.ts`
 * calls this). A plain function over the caller's `ctx`: the deletes stay in the
 * orchestrator's mutation, and the writes are the owner's.
 */
import type { MutationCtx } from "../_generated/server";
import { deleteOneByOne } from "../gdpr/batch";

/**
 * The user's prompts, their version history, the per-thread variable values and
 * the variable defaults. All deleted in one parallel batch, as before.
 */
export const erasePromptsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const [prompts, threadVariables, userDefaults] = await Promise.all([
        ctx.db.prompts.findMany({ where: { userId } }).then((result) => result.page),
        ctx.db
            .query("threadVariables")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect(),
        ctx.db.userVariableDefaults.findMany({ where: { userId } }).then((result) => result.page),
    ]);

    // Parallel fetch all prompt history for all prompts
    const historyByPrompt = await Promise.all(
        prompts.map((prompt) => ctx.db.promptHistory.findMany({ where: { promptId: prompt._id } }).then((result) => result.page)),
    );

    // Flatten all history records
    const allHistory = historyByPrompt.flat();

    // Audited tables, so one delete at a time (`gdpr/batch.ts`). History goes first: it
    // is the child of a prompt.
    await deleteOneByOne(ctx, allHistory);
    await deleteOneByOne(ctx, prompts);
    await deleteOneByOne(ctx, threadVariables);
    await deleteOneByOne(ctx, userDefaults);
};
