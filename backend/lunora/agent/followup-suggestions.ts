/**
 * Follow-up suggestions cache operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery, type QueryCtx as QueryContext } from "../_generated/server";

export const getCachedFollowupSuggestions = internalQuery
    .input({
        threadId: v.string(),
    })
    .output(
        v.union(
            v.object({
                lastMessageId: v.string(),
                suggestions: v.array(v.string()),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx: context }) => getCachedFollowupSuggestionsHandler(context, args));

/**
 * Direct handler for cached follow-up suggestions.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const getCachedFollowupSuggestionsHandler = async (context: QueryContext, args: { threadId: string }) => {
    const cached = await context.db
        .query("followupSuggestions")
        .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
        .first();

    if (!cached) {
        return null;
    }

    return {
        lastMessageId: cached.lastMessageId,
        suggestions: cached.suggestions,
    };
};

export const cacheFollowupSuggestions = internalMutation
    .input({
        lastMessageId: v.string(),
        suggestions: v.array(v.string()),
        threadId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { lastMessageId, suggestions, threadId }, ctx: context }) => {
        const now = context.now;

        const existing = await context.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (existing) {
            await context.db.patch(existing._id, {
                lastMessageId,
                suggestions,
                updatedAt: now,
            });
        } else {
            await context.db.insert("followupSuggestions", {
                createdAt: now,
                lastMessageId,
                suggestions,
                threadId,
                updatedAt: now,
            });
        }

        return null;
    });
