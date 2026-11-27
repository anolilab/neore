/**
 * Memories and reflection digests in the GDPR export; those, the reflection state, the pending cleanups (vectors whose
 * delete failed, the rest of an older-version delete) and the background import jobs (with their stored entries) in
 * account deletion. The import's job and batch rows are erased, never exported: they are a
 * short-lived copy of a file the user supplied, deleted when the job ends, and their entries become memories, which are
 * exported. (Chat import's job rows are handled the same way, `chat-import/gdpr.ts`.)
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-memories") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-memory-reflection", after
 * "delete-user-memories", which removes the memories themselves and their
 * embeddings). Deletion follows the residual steps' contract
 * (`gdpr/steps/residual-deletion-steps.ts`): at most `BATCH` rows per table per
 * call, `{ hasMore }` back, idempotent on retry.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { eraseEmbeddingRow } from "../agent/gdpr";
import { BATCH, type BatchResult } from "../gdpr/batch";

/** Memories in the export — every one the user has, superseded history included (Art. 15 covers it). */
const EXPORT_MEMORY_CAP = 5000;

const EXPORT_DIGEST_CAP = 100;

export const collectMemoriesForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ digests: v.array(v.any()), memories: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const [memories, digests] = await Promise.all([
            ctx.db
                .query("memories")
                .withIndex("by_userId_type", (q) => q.eq("userId", userId))
                .take(EXPORT_MEMORY_CAP),
            ctx.db
                .query("memoryDigests")
                .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
                .order("desc")
                .take(EXPORT_DIGEST_CAP),
        ]);

        return {
            digests: digests.map(({ _id, ...digest }) => {
                return { id: _id, ...digest };
            }),
            // The vector reference is an internal pointer, not the user's data.
            memories: memories.map(({ _id, embeddingId: _embeddingId, ...memory }) => {
                return { id: _id, ...memory, type: memory.type };
            }),
        };
    });

/**
 * The user's memories, each with its embedding (`agent/gdpr.ts#eraseEmbeddingRow`,
 * which tolerates a row already gone). Batched: `hasMore` while a full batch came back.
 */
export const eraseMemoriesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const memories = await ctx.db
        .query("memories")
        .withIndex("by_userId_type", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(
        memories.map(async (m) => {
            // embeddingId is a JSON-stored string ID referencing a dimension-specific embeddings table
            if (m.embeddingId) {
                await eraseEmbeddingRow(ctx, m.embeddingId, `embedding for memory ${m._id}`);
            }

            await ctx.db.delete("memories", m._id);
        }),
    );

    return { hasMore: memories.length >= BATCH };
};

export const deleteUserMemoryReflectionData = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const [cleanups, digests, states, importJobs, importBatches] = await Promise.all([
            ctx.db
                .query("memoryCleanups")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("memoryDigests")
                .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("memoryReflectionState")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .take(BATCH),
            // A background file import: its stored entries are the user's memories, so they go first.
            ctx.db
                .query("memoryImportJobs")
                .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("memoryImportBatches")
                .withIndex("by_userId", (q) => q.eq("userId", userId))
                .take(BATCH),
        ]);

        // A pending run would no-op anyway (memory reads as off once settings are
        // gone), but cancelling it leaves nothing queued for an erased account.
        for (const state of states) {
            if (state.scheduledJobId) {
                await ctx.scheduler.cancel(state.scheduledJobId).catch(() => undefined);
            }
        }

        // A recorded vector delete is the only reference left to a vector no memory row points at: erase the vector itself.
        for (const row of cleanups) {
            if (row.kind === "vector" && row.embeddingId) {
                await eraseEmbeddingRow(ctx, row.embeddingId, `embedding of retired memory ${row.memoryId ?? ""}`);
            }
        }

        await Promise.all([
            ...cleanups.map((row) => ctx.db.delete("memoryCleanups", row._id)),
            ...digests.map((row) => ctx.db.delete("memoryDigests", row._id)),
            ...states.map((row) => ctx.db.delete("memoryReflectionState", row._id)),
            ...importJobs.map((row) => ctx.db.delete("memoryImportJobs", row._id)),
            ...importBatches.map((row) => ctx.db.delete("memoryImportBatches", row._id)),
        ]);

        return {
            hasMore:
                cleanups.length >= BATCH || digests.length >= BATCH || states.length >= BATCH || importJobs.length >= BATCH || importBatches.length >= BATCH,
        };
    });
