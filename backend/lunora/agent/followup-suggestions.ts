/**
 * Follow-up suggestions cache operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx as QueryContext } from "../_generated/server";
import { getUser } from "../auth/lib/better-auth-queries";
import { claimOnce, releaseClaim } from "../lib/claim-once";
import { isThreadLocked } from "../lib/thread-lock";

/** One paid suggestion call per reply: keyed `<threadId>:<lastMessageId>`, so a second run of the same reply finds it taken. */
export const FOLLOWUP_CLAIM_SCOPE = "followup-suggestions";
/** A reply is paid for once, so its claim outlives any retry of its job: a retry after a failed call is not charged again. */
const FOLLOWUP_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a reply gets a suggestion for this user: the setting is on (absent = on) and the user is not a guest.
 * Read before any model is picked, so a user who switched the setting off costs no call.
 */
export const getFollowupSuggestionGate = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ enabled: v.boolean(), guest: v.boolean() }))
    .query(async ({ args: { userId }, ctx: context }) => {
        const settings = await context.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .unique();
        const user = await getUser(context, userId);

        return { enabled: settings?.enableFollowupSuggestions !== false, guest: user?.isAnonymous === true };
    });

/**
 * The last check before the paid call: the thread is still open, and this reply's suggestion is not already claimed.
 * `false` for a locked or deleted thread, or a reply another run has already paid for.
 */
export const admitFollowupSuggestions = internalMutation
    .input({ lastMessageId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args: { lastMessageId, threadId, userId }, ctx: context }) => {
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (!thread || thread.deletedAt || isThreadLocked(thread)) {
            return false;
        }

        return await claimOnce(context, FOLLOWUP_CLAIM_SCOPE, `${threadId}:${lastMessageId}`, FOLLOWUP_CLAIM_TTL_MS, userId);
    });

/** Gives a reply's claim back when its charge was refused: nothing was paid, so a later run may ask again. */
export const releaseFollowupSuggestions = internalMutation
    .input({ lastMessageId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { lastMessageId, threadId }, ctx: context }) => {
        await releaseClaim(context, FOLLOWUP_CLAIM_SCOPE, `${threadId}:${lastMessageId}`);

        return null;
    });

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
        const { now } = context;

        const existing = await context.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (existing) {
            await context.db.patch("followupSuggestions", existing._id, {
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
