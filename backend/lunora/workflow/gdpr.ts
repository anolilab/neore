/**
 * The workflow module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). Plain functions over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";

/** Workflow versions and presence rows the user wrote, anywhere. */
export const eraseWorkflowVersionsAndPresenceForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [versions, presence] = await Promise.all([
        ctx.db
            .query("workflowVersions")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("workflowPresence")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all([...versions, ...presence].map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(versions) || full(presence) };
};

/** Versions and presence (including other people's) attached to one project. */
export const eraseWorkflowVersionsAndPresenceForProject = async (ctx: MutationCtx, projectId: Id<"projects">): Promise<BatchResult> => {
    const [versions, presence] = await Promise.all([
        ctx.db
            .query("workflowVersions")
            .withIndex("by_project", (q) => q.eq("projectId", projectId))
            .take(BATCH),
        ctx.db
            .query("workflowPresence")
            .withIndex("by_project_and_user", (q) => q.eq("projectId", projectId))
            .take(BATCH),
    ]);

    await Promise.all([...versions, ...presence].map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(versions) || full(presence) };
};
