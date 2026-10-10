import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Search Memory Tool
 *
 * Allows the AI to actively search its memory about the user instead of
 * relying solely on auto-injected memories. This implements the progressive
 * disclosure pattern from claude-mem: memories are available on-demand
 * rather than always injected wholesale into every prompt.
 *
 * Usage: The model calls this tool when the current topic likely has
 * relevant context in memory that wasn't auto-injected at startup.
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { callOnShard } from "../../lib/cross-shard";
import { servesUser } from "../../lib/shard-context";

const searchMemoryTool = createTool<{ limit?: number; query: string }, { memories: { category: string; confidence: number; memory: string }[] }, ToolContext>({
    description:
        "Search your memory about the user for context relevant to the current topic. " +
        "Use this when you need to recall past preferences, projects, skills, or corrections " +
        "that may not have been automatically provided in the conversation context.",
    execute: async (context, { limit = 5, query }) => {
        if (!context.userId) {
            return { memories: [] };
        }

        try {
            // In a thread shared with them, this user's memories are on their own
            // shard, not the owner's this turn runs on (`servesUser`).
            const memoryArgs = { searchText: query, userId: context.userId };
            const memories = servesUser(context.userId)
                ? await context.runAction(internal.memory.retrieve.retrieveRelevantMemories, memoryArgs)
                : await callOnShard(internal.memory.retrieve.retrieveRelevantMemories, memoryArgs, { shardKey: context.userId });

            return {
                memories: memories.slice(0, limit).map((m) => {
                    return {
                        category: m.category,
                        confidence: m.confidence,
                        memory: m.memory,
                    };
                }),
            };
        } catch (error) {
            console.warn("[search_memory] Memory search failed:", error);

            return { memories: [] };
        }
    },
    inputSchema: z.object({
        limit: z.int().min(1).max(10).optional().meta({ description: "Maximum number of memories to return (default: 5)" }),
        query: z
            .string()
            .meta({ description: "Natural language query describing what to search for, e.g. 'user programming preferences' or 'user current projects'" }),
    }),
});

export default searchMemoryTool;
