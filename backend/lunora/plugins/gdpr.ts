/**
 * The plugin tables' erasure for account deletion (called by `gdpr/steps/deletion-steps.ts`). Install rows and their
 * child links are the owner's bookkeeping. The children they point at (skills, triggers, groups) are erased by their
 * own steps, so this removes only the links and the installs.
 */
import type { MutationCtx } from "../_generated/server";
import { type BatchResult, deleteOneByOne } from "../gdpr/batch";

/**
 * Rows per table per call. Both tables are `.global()`, so every delete is a D1 statement and one invocation allows about 50:
 * two reads and up to 2 x 20 deletes stay under it.
 */
const PAGE = 20;

/** One batch of the person's links and installs. `hasMore` while either table may hold more; the workflow calls again. */
export const erasePluginsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: items } = await ctx.db.pluginItems.findMany({ limit: PAGE, where: { userId } });
    const { page: installs } = await ctx.db.pluginInstalls.findMany({ limit: PAGE, where: { userId } });

    await deleteOneByOne(items, async (row) => await ctx.db.delete("pluginItems", row._id));
    await deleteOneByOne(installs, async (row) => await ctx.db.delete("pluginInstalls", row._id));

    return { hasMore: items.length >= PAGE || installs.length >= PAGE };
};
