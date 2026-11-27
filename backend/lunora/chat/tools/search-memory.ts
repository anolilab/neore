import z from "zod/v4";

import type { Id } from "../../_generated/dataModel";
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
import { localDayOf } from "../../memory/reflection-logic";
import toonEncodeOutput from "./toon-encode";

/** A found memory as the model reads it: every row has the same keys, so TOON lists them as one table. */
type FoundMemory = {
    category: string;
    confidence: number;
    /** The user's local day it was last confirmed or saved. */
    confirmedOn: string;
    /** The day or days of the event it is about: `YYYY-MM-DD`, or `YYYY-MM-DD to YYYY-MM-DD`. */
    event: string | null;
    memory: string;
    /** The last day it holds. */
    validUntil: string | null;
};

const eventDays = (start: string | undefined, end: string | undefined): string | null => {
    if (start && end && start !== end) {
        return `${start} to ${end}`;
    }

    return start ?? end ?? null;
};

/**
 * The user's timezone, read beside the search to date each memory. A failed read dates them in UTC: the memories the
 * search found still reach the model.
 */
const readTimeZone = async (context: ToolContext, userId: string, onUserShard: boolean): Promise<string | null> => {
    try {
        return onUserShard
            ? await context.runQuery(internal.memory.functions.getUserTimeZone, { userId })
            : await callOnShard(internal.memory.functions.getUserTimeZone, { userId }, { shardKey: userId });
    } catch (error) {
        console.warn("[search_memory] Timezone read failed, dating memories in UTC:", error);

        return null;
    }
};

const searchMemoryTool = createTool<{ limit?: number; query: string }, { memories: FoundMemory[] }, ToolContext>({
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
            // On a bot thread the bot's memories are searched too. A collaborator's own memories never
            // carry the owner's bot id, so this adds nothing for them.
            const thread = context.threadId
                ? await context.runQuery(internal.agent.threads.getThreadInternal, { threadId: context.threadId as Id<"threads"> })
                : null;
            // A deleted bot's memories are not searched: the bot must still be the caller's.
            const bot = thread?.botId ? await context.runQuery(internal.bots.functions.getBotForRun, { botId: thread.botId, userId: context.userId }) : null;
            // A search of its own: a lower relevance floor than the injection's and the tool's own `limit`, so it
            // finds what the 8 injected memories left out.
            const memoryArgs = { botId: bot ? thread?.botId : undefined, limit, search: true, searchText: query, userId: context.userId };
            const onUserShard = servesUser(context.userId);
            const search = onUserShard
                ? context.runAction(internal.memory.retrieve.retrieveRelevantMemories, memoryArgs)
                : callOnShard(internal.memory.retrieve.retrieveRelevantMemories, memoryArgs, { shardKey: context.userId });
            const [memories, timeZone] = await Promise.all([search, readTimeZone(context, context.userId, onUserShard)]);

            return {
                memories: memories.map((m) => {
                    return {
                        category: m.category,
                        confidence: m.confidence,
                        confirmedOn: localDayOf(m.lastConfirmedAt, timeZone),
                        event: eventDays(m.eventStart, m.eventEnd),
                        memory: m.memory,
                        validUntil: m.validUntil ?? null,
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
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default searchMemoryTool;
