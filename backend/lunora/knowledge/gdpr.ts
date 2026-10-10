/**
 * The knowledge module's erasure for account deletion (called by
 * `gdpr/steps/residual-deletion-steps.ts`). Plain functions over the caller's
 * `ctx`; batching follows `gdpr/batch.ts`. A chunk's embedding row is a vector
 * row owned by `agent`, so it is deleted through `agent/gdpr.ts`.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { eraseEmbeddingRow } from "../agent/gdpr";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";

/**
 * Knowledge files, their chunks, the chunks' embeddings, the thread/project
 * links and the user's knowledge collections. The uploaded bytes are the vault `files` row the knowledge file points
 * at, whose R2 object `deleteUserFiles` removes. Deleting an `embeddings_*` row
 * propagates to its Vectorize index (`db.delete` on a vectorized table does).
 */
export const eraseKnowledgeForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const files = await ctx.db
        .query("knowledgeFiles")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId))
        .take(BATCH);

    let hasMore = full(files);

    for (const file of files) {
        const chunks = await ctx.db
            .query("knowledgeChunks")
            .withIndex("by_fileId_chunkIndex", (q) => q.eq("fileId", file._id))
            .take(BATCH);

        for (const chunk of chunks) {
            if (chunk.embeddingId) {
                await eraseEmbeddingRow(ctx, chunk.embeddingId, "knowledge embedding");
            }

            await ctx.db.delete(chunk._id);
        }

        // A file with more chunks than one batch stays for the next round.
        if (full(chunks)) {
            hasMore = true;
            continue;
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
        // A document added without the vault (folder, Notion export) has its own object.
        await scheduleObjectDeletion(ctx, [file.storageKey]);
        await ctx.db.delete(file._id);
    }

    // Chunks whose file row is already gone.
    const orphans = await ctx.db
        .query("knowledgeChunks")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    for (const chunk of orphans) {
        if (chunk.embeddingId) {
            await eraseEmbeddingRow(ctx, chunk.embeddingId, "knowledge embedding");
        }

        await ctx.db.delete(chunk._id);
    }

    // Collection links on this shard, and the user's collections (`.global()`: ORM facade).
    const links = await ctx.db
        .query("knowledgeCollectionLinks")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);
    const { page: collections } = await ctx.db.knowledgeCollections.findMany({ limit: BATCH, where: { userId } });

    await Promise.all([...links, ...collections].map((row) => ctx.db.delete(row._id)));

    return { hasMore: hasMore || full(orphans) || full(links) || full(collections) };
};

/** A project's knowledge links (`projectKnowledge`), one batch. Runs with the project's other rows. */
export const eraseProjectKnowledgeForProject = async (ctx: MutationCtx, projectId: Id<"projects">): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("projectKnowledge")
        .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(rows) };
};
