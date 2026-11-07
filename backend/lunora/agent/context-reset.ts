/**
 * The "New context" divider (`agent/context-reset-shape.ts` has the row). A scheduled task's run leaves one marking where
 * it began (`appendContextReset`); `/clear` leaves one that cuts the context, which the rest of this file reads.
 *
 * The context reset `/clear` writes The active path is the thread's rows
 * from the root to the row a reply hangs off; a reset cuts it: the model is sent only the rows written after the newest
 * reset on that path. A reset on a branch the person left does not cut the branch they are on.
 *
 * Reads are cheap: the thread keeps the newest reset on its active path in `contextResetMessageId`, written where the
 * path changes (`refreshContextResetPointer`, from `syncActiveAgent`) and where a reset is written. A prompt on the
 * active path reads it with one lookup (a branched thread first checks that with a short walk from the leaf); only a
 * prompt on another branch searches its path, and only a thread that has been cleared pays any of it. Every walk is bounded by
 * {@link MAX_RESET_WALK_PAGES}: a reset further up than that is not found, and the rows above it lie far beyond what any
 * reader sends (the window, the summaries' reach).
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isThreadLocked } from "../lib/thread-lock";
import { getThreadRow, resolveLeafRow, walkPath } from "./branch-rows";
import { CONTEXT_RESET_KEY, isContextResetRow } from "./context-reset-shape";
import { MAX_SEARCH_PAGES } from "./handoff-source";
import { addMessagesHandler } from "./messages";
import { patchThread } from "./table-writes";

type Row = Doc<"messages">;
type Reader = Pick<QueryCtx, "db">;
type ResetThread = Pick<Doc<"threads">, "_id" | "activeLeafMessageId" | "contextResetMessageId" | "hasContextReset">;

/** Rows per path read while looking for a reset. A reset usually sits within the reply window. */
const WALK_BATCH = 100;

/** Pages of {@link WALK_BATCH} rows one lookup reads at most, the bound every reply-context walk keeps. */
export const MAX_RESET_WALK_PAGES = MAX_SEARCH_PAGES;

/**
 * The newest context reset on the path that ends at `tip`, found by walking it, at most {@link MAX_RESET_WALK_PAGES}
 * pages up. Used where the path changes, and as the fallback of {@link resetForTip}.
 */
export const contextResetOnPath = async (context: Reader, threadId: Id<"threads">, tip: Row): Promise<Row | null> => {
    let from: Row | null = tip;

    for (let page = 0; from && page < MAX_RESET_WALK_PAGES; page += 1) {
        const { next, rows } = await walkPath(context, threadId, from, { limit: WALK_BATCH });
        const reset = rows.find((row) => isContextResetRow(row));

        if (reset) {
            return reset;
        }

        from = next;
    }

    return null;
};

/**
 * Whether `tip` lies on the ACTIVE path: a walk up from the displayed leaf that stops below `tip`'s order. A reply's prompt
 * sits at or near the leaf, so this reads about one page.
 */
const isOnActivePath = async (context: Reader, thread: ResetThread & { activeLeafMessageId: string }, tip: Row): Promise<boolean> => {
    const leaf = await resolveLeafRow(context, thread._id, thread.activeLeafMessageId);
    let from: Row | null = leaf;

    for (let page = 0; from && page < MAX_RESET_WALK_PAGES; page += 1) {
        const { next, rows } = await walkPath(context, thread._id, from, { limit: WALK_BATCH, stopBelowOrder: tip.order });

        if (rows.some((row) => row._id === tip._id)) {
            return true;
        }

        from = next;
    }

    return false;
};

/**
 * The newest context reset on the path that ends at `tip`. A thread that never cleared reads nothing. The thread's
 * pointer names the newest reset on the ACTIVE path (every branch change refreshes it), so a tip on that path reads it
 * with one lookup; on a branched thread that is checked first with a short walk from the leaf. A tip on another branch,
 * or one written before the pointed reset, searches its own path (bounded).
 */
export const resetForTip = async (context: Reader, thread: ResetThread, tip: Row): Promise<Row | null> => {
    if (!thread.hasContextReset) {
        return null;
    }

    const { activeLeafMessageId } = thread;

    if (activeLeafMessageId !== undefined && !(await isOnActivePath(context, { ...thread, activeLeafMessageId }, tip))) {
        return await contextResetOnPath(context, thread._id, tip);
    }

    if (thread.contextResetMessageId === "") {
        return null;
    }

    if (thread.contextResetMessageId) {
        const reset = await getThreadRow(context, thread._id, thread.contextResetMessageId);

        // A tip written after the newest reset is cut by it; an earlier tip may lie past an older one, so it searches.
        if (reset && isContextResetRow(reset) && reset.order <= tip.order) {
            return reset;
        }
    }

    // Not known (a reset written without the pointer), the pointed row is gone, or `tip` predates it: search the path.
    return await contextResetOnPath(context, thread._id, tip);
};

/**
 * Recomputes the thread's pointer for the path that now ends at `fromMessageId`. Called where the active path changes
 * (`syncActiveAgent`), after the thread's own leaf is written. Nothing is written for a thread that never cleared.
 */
export const refreshContextResetPointer = async (ctx: MutationCtx, threadId: Id<"threads">, fromMessageId: string): Promise<void> => {
    const thread = await ctx.db.get("threads", threadId);

    if (!thread?.hasContextReset) {
        return;
    }

    const from = await getThreadRow(ctx, threadId, fromMessageId);
    const reset = from ? await contextResetOnPath(ctx, threadId, from) : null;

    if ((reset?._id ?? "") !== thread.contextResetMessageId) {
        await patchThread(ctx.db, threadId, { contextResetMessageId: reset?._id ?? "" });
    }
};

/**
 * The rows (oldest first) the model is sent after `reset`: those written after it. `null` = no reset, every row counts.
 * A reset takes the next `order` past everything before it, and a turn's rows share their order, so `order` alone decides.
 */
export const rowsAfterContextReset = <R extends { order: number }>(rows: ReadonlyArray<R>, reset: { order: number } | null): R[] =>
    reset ? rows.filter((row) => row.order > reset.order) : [...rows];

/**
 * Appends a task run's divider (`reason: "task_run"`) to `threadId` when it is `userId`'s; does nothing otherwise. Returns
 * whether it wrote one. It marks where the run began; it does not cut what later replies read (only `/clear`'s does).
 */
export const appendContextReset = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        // A locked chat is written to only with the owner's unlock proof, which a scheduled run never has.
        if (!thread || thread.userId !== args.userId || thread.deleted === true || isThreadLocked(thread)) {
            return false;
        }

        // In a branched thread a system row is not hung under the displayed leaf by default, so it is named here.
        const leaf = thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : null;

        await addMessagesHandler(ctx, {
            failPendingSteps: false,
            ...(leaf && { parentMessageId: leaf._id }),
            messages: [{ message: { content: "", role: "system" }, providerMetadata: { [CONTEXT_RESET_KEY]: { reason: "task_run" } }, status: "success" }],
            threadId: args.threadId,
            userId: args.userId,
        });

        return true;
    });
