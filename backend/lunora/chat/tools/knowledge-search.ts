import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Knowledge Base Search Tool
 *
 * Allows the AI to search user-uploaded knowledge base files
 * for relevant information using vector similarity search.
 * Follows the searchMemory tool pattern.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";

const knowledgeSearchTool = createTool<
    { fileIds?: string[]; query: string },
    { results: { chunkIndex: number; content: string; fileName: string; score: number }[] },
    ToolContext
>({
    description:
        "Search your uploaded knowledge base files for relevant information. " +
        "Use this when the user has uploaded documents to their knowledge base and you need to " +
        "find specific facts, data, or context from those files. " +
        "Results are ranked by relevance using semantic similarity.",
    execute: async (context, { fileIds, query }) => {
        if (!context.userId) {
            return { results: [] };
        }

        try {
            const results = await context.runAction(internal.knowledge.retrieve.search, {
                fileIds,
                query,
                threadId: context.threadId ?? undefined,
                userId: context.userId,
            });

            return { results };
        } catch (error) {
            console.warn("[knowledge_search] Search failed:", error);

            return { results: [] };
        }
    },
    inputSchema: z.object({
        fileIds: z.array(z.string()).optional().meta({ description: "Optional: limit search to specific knowledge file IDs" }),
        query: z.string().min(1).max(2000).meta({ description: "Natural language query describing what to search for in the knowledge base" }),
    }),
    title: "Knowledge Base Search",
});

export default knowledgeSearchTool;
