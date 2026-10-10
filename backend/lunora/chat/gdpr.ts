/**
 * The chat module's erasure for account deletion (`gdpr/steps/deletion-steps.ts`
 * and `residual-deletion-steps.ts` call these). Plain functions over the caller's
 * `ctx`, so the deletes stay in the orchestrator's mutation and the writes are
 * the owner's. Batching follows `gdpr/batch.ts`.
 */
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, deleteParentsWithChildren } from "../gdpr/batch";

/** The user's pins and tags on their threads (relationships and grants are `agent/gdpr.ts`). */
export const eraseThreadPinsAndTagsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const [pins, threadTags] = await Promise.all([
        ctx.db
            .query("threadPins")
            .withIndex("by_user_and_thread", (q) => q.eq("userId", userId))
            .collect(),
        ctx.db
            .query("threadTags")
            .withIndex("by_user_and_order", (q) => q.eq("userId", userId))
            .collect(),
    ]);

    await Promise.all([...pins.map((p) => ctx.db.delete(p._id)), ...threadTags.map((tag) => ctx.db.delete(tag._id))]);
};

/**
 * Tool-approval snapshots, then a stream per reply and every chunk of it. The
 * approval snapshots carry the run's final system prompt, which can hold memory
 * and personalisation text.
 */
export const erasePersistentStreamsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [streams, approvalRuns] = await Promise.all([
        ctx.db
            .query("persistentStreams")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_userId_status_createdAt", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all(approvalRuns.map(async (run) => await ctx.db.delete(run._id)));

    const streamsLeft = await deleteParentsWithChildren(
        ctx,
        streams,
        async (stream) =>
            await ctx.db
                .query("persistentChunks")
                .withIndex("by_streamId_seq", (q) => q.eq("streamId", stream._id))
                .take(BATCH),
    );

    return { hasMore: streamsLeft || approvalRuns.length >= BATCH };
};

/** The user's presentations, each after its slides. */
export const erasePresentationsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const presentations = await ctx.db
        .query("presentations")
        .withIndex("by_user_and_thread", (q) => q.eq("userId", userId))
        .take(BATCH);

    const hasMore = await deleteParentsWithChildren(
        ctx,
        presentations,
        async (presentation) =>
            await ctx.db
                .query("presentationSlides")
                .withIndex("by_presentation_and_number", (q) => q.eq("presentationId", presentation._id))
                .take(BATCH),
    );

    return { hasMore };
};
