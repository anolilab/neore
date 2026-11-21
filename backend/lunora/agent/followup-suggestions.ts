/**
 * Follow-up suggestions cache operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx as QueryContext } from "../_generated/server";
import { getUser } from "../auth/lib/better-auth-queries";
import { claimFence, dropExpiredClaimsWithPrefix, hasClaimWithPrefix, releaseClaim } from "../lib/claim-once";
import { isThreadLocked } from "../lib/thread-lock";

/** One paid suggestion call per reply: keyed `<threadId>:<lastMessageId>`, so a second run of the same reply finds it taken. */
export const FOLLOWUP_CLAIM_SCOPE = "followup-suggestions";
/**
 * The claim covers one run in flight, and lapses so an interrupted run (a killed action leaves no catch to release it) can be retried.
 * A retry is not charged again: the Text charge is keyed per reply and holds for a day (`chat/daily-charge.ts`). Once a reply is
 * cached, the cache check ends every later run before admission.
 */
const FOLLOWUP_CLAIM_TTL_MS = 60 * 60 * 1000;

/** A model request in flight for a chat: a lock waits for it, and the claim goes as soon as the request settles. */
export const FOLLOWUP_DISPATCH_SCOPE = "followup-dispatch";
/** Long enough for one model call; a job that dies lets the chat be locked again after this. The model call itself is cut off at half of it. */
export const FOLLOWUP_DISPATCH_TTL_MS = 2 * 60 * 1000;

/** The fields of a message row that decide which row a reply is keyed by. */
export interface ReplyAnchorRow {
    message?: { role?: string } | null;
    order: number;
    stepOrder: number;
}

/**
 * The row a reply is keyed by: the first row of the last assistant group the composer shows. The UI closes a group at
 * every user or system row of the turn (ui-messages.ts), so only rows after the last of those belong to the reply on
 * screen. A switch divider (a system row) is never the anchor, because the composer never shows it. Only the boundaries before the
 * newest reply's row count: a divider appended after the reply (a task run's) starts nothing and must not move the anchor.
 */
export const replyAnchorRow = <Row extends ReplyAnchorRow>(turnRows: ReadonlyArray<Row>, newest: Row): Row => {
    const isBoundary = (row: Row) => row.message?.role === "user" || row.message?.role === "system";
    const turn = turnRows.filter((row) => row.order === newest.order);
    const boundary = Math.max(-Infinity, ...turn.filter((row) => isBoundary(row) && row.stepOrder < newest.stepOrder).map((row) => row.stepOrder));

    let anchor = newest;

    for (const row of turn) {
        if (row.stepOrder > boundary && !isBoundary(row) && row.stepOrder < anchor.stepOrder) {
            anchor = row;
        }
    }

    return anchor;
};

/**
 * The rows the suggestion model reads: the reply's whole turn, its user prompt included, then the older rows of the first page.
 * Both lists come newest first and the result keeps that order, so a tool turn longer than one page is not cut short.
 */
export const followupModelRows = <Row extends { _id: string }>(turnRows: ReadonlyArray<Row>, pageRows: ReadonlyArray<Row>): Row[] => {
    const inTurn = new Set(turnRows.map((row) => row._id));

    return [...turnRows, ...pageRows.filter((row) => !inTurn.has(row._id))];
};

/**
 * Runs `call` with a signal that aborts after `timeoutMs`. An explicit timer, not `AbortSignal.timeout`: the deadline must fire
 * whatever the runtime does with that signal, and it is cleared as soon as the call settles.
 */
export const withDeadline = async <T>(timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await call(controller.signal);
    } finally {
        clearTimeout(deadline);
    }
};

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
 * The last check before the paid call: the thread is still open, and this reply's suggestion is not already claimed. Answers the
 * claim's `claimedAt`, the fence the run releases with, or `null` for a locked or deleted thread, or a reply another run holds.
 */
export const admitFollowupSuggestions = internalMutation
    .input({ lastMessageId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.union(v.null(), v.number()))
    .mutation(async ({ args: { lastMessageId, threadId, userId }, ctx: context }) => {
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        // A hard delete marks `deletingAt` while its rows are still readable, so that window is closed too.
        if (!thread || thread.deletedAt || thread.deletingAt !== undefined || isThreadLocked(thread)) {
            return null;
        }

        return await claimFence(context, FOLLOWUP_CLAIM_SCOPE, `${threadId}:${lastMessageId}`, { ttlMs: FOLLOWUP_CLAIM_TTL_MS, userId });
    });

/**
 * Gives a reply's claim back, when its charge was refused or its run failed before the cache: a later run may ask again. Only the claim
 * this run took (`claimedAt`) is freed: a run whose claim lapsed must not free the claim a later run has taken on the same key.
 */
export const releaseFollowupSuggestions = internalMutation
    .input({ claimedAt: v.number(), lastMessageId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { claimedAt, lastMessageId, threadId }, ctx: context }) => {
        await releaseClaim(context, FOLLOWUP_CLAIM_SCOPE, `${threadId}:${lastMessageId}`, claimedAt);

        return null;
    });

/**
 * Lets one follow-up model request leave: checks the thread is still open and takes the request's dispatch claim, in one
 * transaction. Locking a chat refuses while the claim is held (`agent/thread-lock.ts`), so either the lock lands first and
 * nothing is sent, or the request goes out first and the lock waits for it. `null` when the request must not be sent.
 */
export const beginFollowupDispatch = internalMutation
    .input({ requestId: v.string(), threadId: v.string() })
    .output(v.union(v.null(), v.number()))
    .mutation(async ({ args: { requestId, threadId }, ctx: context }) => {
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        if (!thread || thread.deletedAt || thread.deletingAt !== undefined || isThreadLocked(thread)) {
            return null;
        }

        // Dispatches whose end never landed are cleared here, so the lock's check reads a short range.
        await dropExpiredClaimsWithPrefix(context, FOLLOWUP_DISPATCH_SCOPE, `${threadId}:`);

        return await claimFence(context, FOLLOWUP_DISPATCH_SCOPE, `${threadId}:${requestId}`, { ttlMs: FOLLOWUP_DISPATCH_TTL_MS });
    });

/** The request has settled: its dispatch claim goes, and the chat may be locked again. */
export const endFollowupDispatch = internalMutation
    .input({ claimedAt: v.number(), requestId: v.string(), threadId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { claimedAt, requestId, threadId }, ctx: context }) => {
        await releaseClaim(context, FOLLOWUP_DISPATCH_SCOPE, `${threadId}:${requestId}`, claimedAt);

        return null;
    });

/** Whether a follow-up model request is in flight for this chat. */
export const followupDispatchInFlight = async (context: Pick<QueryContext, "db">, threadId: string): Promise<boolean> =>
    await hasClaimWithPrefix(context, FOLLOWUP_DISPATCH_SCOPE, `${threadId}:`);

/** Whether a suggestion for this chat is being sent to a model now: the chat's delete actions wait for it (`chat/functions.ts`). */
export const followupInFlight = internalQuery
    .input({ threadId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { threadId }, ctx }) => await followupDispatchInFlight(ctx, threadId));

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

/**
 * Stores the suggestions for one reply. The check and the write run in one mutation, so a run for an older reply that
 * finishes late is refused when a newer reply's suggestions are already stored. A reply is older than the stored one when
 * its turn is older, or when it is a sibling of the same turn that was created earlier (siblings share `order`).
 */
export const cacheFollowupSuggestions = internalMutation
    .input({
        lastMessageId: v.string(),
        order: v.number(),
        replyAt: v.number(),
        suggestions: v.array(v.string()),
        threadId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { lastMessageId, order, replyAt, suggestions, threadId }, ctx: context }) => {
        const { now } = context;
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        // A deleted thread keeps no suggestions, and a hard delete marks `deletingAt` first, so that window keeps none either.
        if (!thread || thread.deletedAt || thread.deletingAt !== undefined) {
            return null;
        }

        const existing = await context.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .first();

        if (existing) {
            const olderTurn = existing.order !== undefined && existing.order > order;
            const olderSibling = existing.order === order && existing.replyAt !== undefined && existing.replyAt > replyAt;

            // A newer reply's suggestions are already stored: this older run must not replace them.
            if (olderTurn || olderSibling) {
                return null;
            }

            await context.db.patch("followupSuggestions", existing._id, {
                lastMessageId,
                order,
                replyAt,
                suggestions,
                updatedAt: now,
            });
        } else {
            await context.db.insert("followupSuggestions", {
                createdAt: now,
                lastMessageId,
                order,
                replyAt,
                suggestions,
                threadId,
                updatedAt: now,
            });
        }

        return null;
    });
