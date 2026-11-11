import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { patchRow } from "../../lib/patch";

/** Projects one mutation clears; a revoke with more than this continues in a scheduled run (`clearDeviceProjects`). */
export const PROJECT_CLEAR_BATCH = 100;

/**
 * Removes the machine and folder from up to one batch of the user's projects that live on `machineId`; the projects stay.
 * Resolves to `true` when the batch was full, so projects may remain. Idempotent: a repeated run finds fewer rows or none.
 */
export const clearProjectsBatch = async (ctx: Pick<MutationCtx, "db">, userId: string, machineId: Id<"devices">): Promise<boolean> => {
    const { page } = await ctx.db.projects.findMany({ limit: PROJECT_CLEAR_BATCH, where: { machineId, userId } });

    for (const project of page) {
        await patchRow(ctx.db, "projects", project, { machineId: undefined, path: undefined });
    }

    return page.length === PROJECT_CLEAR_BATCH;
};
