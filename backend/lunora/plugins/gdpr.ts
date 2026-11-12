/**
 * The plugin tables' erasure for account deletion (called by `gdpr/steps/deletion-steps.ts`). Install rows and their
 * child links are the owner's bookkeeping. The children they point at (skills, triggers, groups) are erased by their
 * own steps, so this removes only the links and the installs.
 */
import type { MutationCtx } from "../_generated/server";

export const erasePluginsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const [items, installs] = await Promise.all([
        ctx.db.pluginItems.findMany({ where: { userId } }).then((result) => result.page),
        ctx.db.pluginInstalls.findMany({ where: { userId } }).then((result) => result.page),
    ]);

    await Promise.all([...items.map((row) => ctx.db.delete("pluginItems", row._id)), ...installs.map((row) => ctx.db.delete("pluginInstalls", row._id))]);
};
