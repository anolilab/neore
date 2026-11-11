import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { patchRow } from "../../lib/patch";

/** Projects one scheduled run clears; a run that clears a full batch schedules the next (`clearDeviceProjects`). */
export const PROJECT_CLEAR_BATCH = 100;

/** Cleanup retries until it succeeds: a dead-lettered run would leave its projects pointing at a deleted device, with nothing left to queue it again. */
export const CLEAR_PROJECTS_RETRY = { forever: true } as const;

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
