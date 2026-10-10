/**
 * Knowledge Base Embedding Deletion
 *
 * Background action to delete embeddings when a knowledge file is removed.
 * Runs as an action because vector deletion requires action context.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";

export const deleteEmbeddingsBatch = internalAction
    .input({
        embeddingIds: v.array(v.string()),
    })
    .action(async ({ args: { embeddingIds }, ctx }) => {
        if (embeddingIds.length === 0) {
            return;
        }

        try {
            await ctx.runMutation(internal.agent.vector.deleteBatch, {
                ids: embeddingIds,
            });
        } catch (error) {
            console.error("[knowledge/deleteEmbeddings] Failed to delete embeddings:", error);
        }
    });

export default deleteEmbeddingsBatch;
