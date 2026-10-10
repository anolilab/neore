/**
 * Removing one knowledge file with everything hanging off it: chunks, their
 * embeddings (deferred — an action deletes vectors), the thread and project
 * links, and the object stored for a pasted, folder or archive document.
 * An uploaded file's vault row is the user's and stays.
 *
 * Many files at once (a collection deleted with its files) are not removed in
 * the caller's mutation: they are marked {@link DELETING_STATUS} and drained a
 * bounded batch at a time by `knowledge/housekeeping.ts`.
 */
import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

/** A file marked for removal: hidden from the user at once, drained in the background. */
export const DELETING_STATUS = "deleting";

/**
 * Deletes up to `limit` of the file's chunks, scheduling their embeddings'
 * deletion. `done` when none are left, so {@link deleteKnowledgeFile} can
 * finish the file within a bounded mutation.
 */
export const deleteKnowledgeFileChunks = async (
    ctx: Pick<MutationCtx, "db" | "scheduler">,
    fileId: Id<"knowledgeFiles">,
    limit: number,
): Promise<{ deleted: number; done: boolean }> => {
    const chunks = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_fileId_chunkIndex", (q) => q.eq("fileId", fileId))
        .take(limit + 1);
    const batch = chunks.slice(0, limit);
    const embeddingIds = batch.map((chunk) => chunk.embeddingId).filter((id): id is string => typeof id === "string" && id.length > 0);

    await Promise.all(batch.map((chunk) => ctx.db.delete(chunk._id)));

    if (embeddingIds.length > 0) {
        await ctx.scheduler.runAfter(0, internal.knowledge.delete_embeddings.deleteEmbeddingsBatch, { embeddingIds });
    }

    return { deleted: batch.length, done: chunks.length <= limit };
};

export const deleteKnowledgeFile = async (ctx: Pick<MutationCtx, "db" | "scheduler">, file: Doc<"knowledgeFiles">): Promise<void> => {
    const chunks = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_fileId_chunkIndex", (q) => q.eq("fileId", file._id))
        .collect();
    const embeddingIds = chunks.map((chunk) => chunk.embeddingId).filter((id): id is string => typeof id === "string" && id.length > 0);

    await Promise.all(chunks.map((chunk) => ctx.db.delete(chunk._id)));

    if (embeddingIds.length > 0) {
        await ctx.scheduler.runAfter(0, internal.knowledge.delete_embeddings.deleteEmbeddingsBatch, { embeddingIds });
    }

    const [threadLinks, projectLinks] = await Promise.all([
        ctx.db
            .query("threadKnowledge")
            .withIndex("by_knowledgeFileId", (q) => q.eq("knowledgeFileId", file._id))
            .collect(),
        ctx.db
            .query("projectKnowledge")
            .withIndex("by_knowledgeFileId", (q) => q.eq("knowledgeFileId", file._id))
            .collect(),
    ]);

    await Promise.all([...threadLinks, ...projectLinks].map((link) => ctx.db.delete(link._id)));
    await scheduleObjectDeletion(ctx, [file.storageKey]);
    await ctx.db.delete(file._id);
};
