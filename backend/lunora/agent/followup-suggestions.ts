/**
 * Follow-up suggestions cache operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx as QueryContext } from "../_generated/server";
import { getUser } from "../auth/lib/better-auth-queries";
import { claimFence, dropExpiredClaimsWithPrefix, hasClaimWithPrefix, holdClaim, holdTtlFrom, releaseClaim } from "../lib/claim-once";
import { isThreadLocked } from "../lib/thread-lock";
import { isLocalBrowserModel, loadCustomProviders } from "../chat/lib/local-turn";
import { loadActivePathTail } from "./branch-rows";

/**
 * Which of the given messages a local-browser model wrote, judged by the owner's own custom endpoints. Those rows stay on the device,
 * so the suggestion job leaves them out of the history it sends to a cloud model.
 */
export const localBrowserRowIds = internalQuery
    .input({ messageIds: v.array(v.string()), userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx: context }) => {
        const providers = await loadCustomProviders(context, args.userId);
        const flags = await Promise.all(
            args.messageIds.map(async (messageId) => {
                const row = await context.db.get("messages", messageId as Id<"messages">);

                return row !== null && isLocalBrowserModel(row.model, providers) ? messageId : null;
            }),
        );

        return flags.filter((messageId): messageId is string => messageId !== null);
    });

/** How many rows of a branched thread's active path the job reads: a turn longer than this is not keyed (see the job). */
export const FOLLOWUP_PATH_LIMIT = 60;

/**
 * The ids on a branched thread's active path, newest first, capped at {@link FOLLOWUP_PATH_LIMIT}. The composer shows exactly these
 * rows, so the job reads them rather than the raw rows, where replies on other branches share an `order`.
 */
export const activePathIds = internalQuery
    .input({ leafId: v.string(), threadId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => {
        const rows = await loadActivePathTail(ctx, args.threadId as Id<"threads">, args.leafId, FOLLOWUP_PATH_LIMIT);

        return rows.map((row) => row._id);
    });

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
/**
 * Renews a reply's claim for another hour from now, while its cache write is still being retried: a later run for the same reply
 * then finds the claim held and does not call the model again. Only the claim that took the reply renews it.
 */
export const holdFollowupClaim = internalMutation
    .input({ claimedAt: v.number(), lastMessageId: v.string(), threadId: v.string(), userId: v.string() })
    .output(v.boolean())
    .mutation(
        async ({ args: { claimedAt, lastMessageId, threadId, userId }, ctx: context }) =>
            await holdClaim(
                context,
                FOLLOWUP_CLAIM_SCOPE,
                `${threadId}:${lastMessageId}`,
                claimedAt,
                holdTtlFrom(claimedAt, FOLLOWUP_CLAIM_TTL_MS, context.now),
                userId,
            ),
    );

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

/** How many replies' suggestions a thread keeps: the newest, so a branch the person can switch back to keeps its own row. */
export const FOLLOWUP_CACHE_ROWS = 20;

/** Newer replies first: the later turn, then the later sibling of the same turn, then the row written later. */
export const newerFirst = <Row extends { createdAt: number; order?: number; replyAt?: number }>(a: Row, b: Row): number =>
    (b.order ?? -1) - (a.order ?? -1) || (b.replyAt ?? -1) - (a.replyAt ?? -1) || b.createdAt - a.createdAt;

export const getCachedFollowupSuggestions = internalQuery
    .input({
        lastMessageId: v.optional(v.string()),
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
export const getCachedFollowupSuggestionsHandler = async (context: QueryContext, { lastMessageId, threadId }: { lastMessageId?: string; threadId: string }) => {
    // With a reply id, that reply's own row (one per reply); without one, the thread's newest reply.
    const rows =
        lastMessageId === undefined
            ? await context.db
                  .query("followupSuggestions")
                  .withIndex("by_thread", (q) => q.eq("threadId", threadId))
                  .collect()
            : await context.db
                  .query("followupSuggestions")
                  .withIndex("by_thread_and_message", (q) => q.eq("threadId", threadId).eq("lastMessageId", lastMessageId))
                  .collect();
    const cached = rows.toSorted(newerFirst)[0];

    if (!cached) {
        return null;
    }

    return {
        lastMessageId: cached.lastMessageId,
        suggestions: cached.suggestions,
    };
};

/**
 * Stores the suggestions for one reply, in that reply's own row. The check and the write run in one mutation, so a run for an
 * older reply that finishes late is refused when a newer reply on the same branch already has suggestions. A reply is older than
 * a stored one when its turn is older, or when it is a sibling of the same turn that was created earlier (siblings share `order`).
 * A reply's own row is always rewritten, so its clear or retry is not refused.
 *
 * `pathIds` is the active path of a branched thread, the rows the composer shows. A stored reply counts only when it is on that
 * path: a reply on an inactive branch never blocks the branch being written. Without it the thread has one branch, and every
 * stored reply counts.
 */
export const cacheFollowupSuggestions = internalMutation
    .input({
        lastMessageId: v.string(),
        order: v.number(),
        pathIds: v.optional(v.array(v.string())),
        replyAt: v.number(),
        suggestions: v.array(v.string()),
        threadId: v.string(),
    })
    .output(v.boolean())
    .mutation(async ({ args: { lastMessageId, order, pathIds, replyAt, suggestions, threadId }, ctx: context }) => {
        const { now } = context;
        const thread = await context.db.get("threads", threadId as Id<"threads">);

        // A deleted thread keeps no suggestions, and a hard delete marks `deletingAt` first, so that window keeps none either.
        if (!thread || thread.deletedAt || thread.deletingAt !== undefined) {
            return false;
        }

        const stored = await context.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .collect();
        const own = stored.find((row) => row.lastMessageId === lastMessageId);

        // A reply's own row is rewritten in place, so its clear or retry is never refused by another reply's row.
        if (own) {
            await context.db.patch("followupSuggestions", own._id, { lastMessageId, order, replyAt, suggestions, updatedAt: now });

            return true;
        }

        // A newer reply on this branch already has its suggestions: this older run must not be written, so it is not charged.
        const newerOnBranch = stored.some(
            (row) =>
                (pathIds === undefined || pathIds.includes(row.lastMessageId)) &&
                ((row.order !== undefined && row.order > order) || (row.order === order && row.replyAt !== undefined && row.replyAt > replyAt)),
        );

        if (newerOnBranch) {
            return false;
        }

        // The thread keeps its newest replies: the oldest rows make room for this one.
        await Promise.all(
            stored
                .toSorted(newerFirst)
                .slice(FOLLOWUP_CACHE_ROWS - 1)
                .map(async (row) => await context.db.delete("followupSuggestions", row._id)),
        );

        await context.db.insert("followupSuggestions", {
            createdAt: now,
            lastMessageId,
            order,
            replyAt,
            suggestions,
            threadId,
            updatedAt: now,
        });

        return true;
    });
