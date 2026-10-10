import type { PaginationResult } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwBadRequest, throwForbidden, throwThreadNotFound } from "../lib/error-helpers";
import { childrenOf, contextPathIds, descendFrom, getThreadRow, loadActivePath, parentOf, resolveLeafRow, walkPath } from "./branch-rows";
import type { MessageBranch } from "./branch-tree";
import { BRANCH_ROOT, forkEnd } from "./branch-tree";
import { addMessagesHandler, getMaxMessage } from "./messages";
import type { Message } from "./validators";
import { vMessage } from "./validators";
import { admitOwnedThread } from "./thread-read-access";
import { MAX_LENGTH } from "../lib/validators";

/**
 * In-thread branching — the procedures, and the active-path page the message
 * lists serve. The tree model is `branch-tree.ts`; the walk they all read
 * through is `branch-rows.ts`.
 */

const BRANCH_CURSOR_PREFIX = "branch:";

/** A page that runs up to a pinned `endCursor` stops here if that row has left the path. */
const MAX_PINNED_PAGE_ROWS = 500;

const parseBranchCursor = (cursor: string | null | undefined): string | undefined =>
    cursor?.startsWith(BRANCH_CURSOR_PREFIX) ? cursor.slice(BRANCH_CURSOR_PREFIX.length) || undefined : undefined;

/**
 * One page of the thread's ACTIVE path, newest first, or `null` for a thread
 * that never branched — which keeps the caller on its linear index scan.
 *
 * Walks up from the leaf (`branch-rows.ts`), so a page costs about its own
 * size in reads however large the thread is. Cursors name the row the next
 * page starts at (`branch:<messageId>`): the path only ever grows at the leaf,
 * so a pinned `endCursor` still yields neither gaps nor duplicates. A cursor
 * from before the thread branched cannot be mapped and ends the list; the
 * first page re-runs reactively and hands out new ones.
 */
export const listActivePathPage = async (
    context: QueryContext,
    thread: Pick<Doc<"threads">, "_id" | "activeLeafMessageId">,
    paginationOptions: { cursor: string | null; endCursor?: string; numItems: number },
): Promise<(PaginationResult<Doc<"messages">> & { branches: Map<string, MessageBranch> }) | null> => {
    if (!thread.activeLeafMessageId) {
        return null;
    }

    const threadId = thread._id;
    const branches = new Map<string, MessageBranch>();
    const done = { branches, continueCursor: "", isDone: true, page: [] };
    const cursorId = paginationOptions.cursor === null ? undefined : parseBranchCursor(paginationOptions.cursor);

    if (paginationOptions.cursor !== null && !cursorId) {
        return done;
    }

    const start = cursorId ? await getThreadRow(context, threadId, cursorId) : await resolveLeafRow(context, threadId, thread.activeLeafMessageId);

    if (!start) {
        return done;
    }

    const stopAtId = parseBranchCursor(paginationOptions.endCursor);
    const { next, rows } = await walkPath(context, threadId, start, {
        limit: stopAtId ? MAX_PINNED_PAGE_ROWS : paginationOptions.numItems,
        stopAtId,
    });

    // Each row's parent is the row after it in the walk; the last row's is
    // `next` (`null` = top level). Siblings are that parent's children.
    await Promise.all(
        rows.map(async (row, index) => {
            const siblings = await childrenOf(context, threadId, rows[index + 1] ?? next);

            if (siblings.length > 1) {
                branches.set(row._id, {
                    count: siblings.length,
                    index: siblings.findIndex((sibling) => sibling._id === row._id),
                    siblingIds: siblings.map((sibling) => sibling._id as string),
                });
            }
        }),
    );

    return { branches, continueCursor: next ? `${BRANCH_CURSOR_PREFIX}${next._id}` : "", isDone: next === null, page: rows };
};

/** Hands each UI message on a branch point its sibling position, for the switcher. */
export const withBranchInfo = <M extends { branch?: MessageBranch; id: string }>(messages: M[], branches: Map<string, MessageBranch> | undefined): M[] => {
    if (branches && branches.size > 0) {
        for (const message of messages) {
            const branch = branches.get(message.id);

            if (branch) {
                message.branch = branch;
            }
        }
    }

    return messages;
};

/**
 * The ids an agent may read as history for `promptMessageId`, or `null` for an
 * unbranched thread, where every row already is history.
 */
export const getContextPathIds = internalQuery
    .input({ promptMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.union(v.null(), v.array(v.string())))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (!thread?.activeLeafMessageId) {
            return null;
        }

        const prompt = await ctx.db.get(args.promptMessageId);

        if (!prompt || prompt.threadId !== args.threadId) {
            return null;
        }

        return await contextPathIds(ctx, args.threadId, prompt);
    });

const vForkTarget = { index: v.optional(v.number()), messageId: v.optional(v.string()), threadId: v.id("threads") };

/**
 * The thread's ACTIVE path, top first, cut after the last row a fork at
 * `messageId` (or, legacy, at display position `index`) copies — so an
 * off-path sibling or a tool row never shifts it — plus that message's display
 * position. With neither, the whole path (a thread-level fork). Empty when the
 * target is not on the path.
 */
const loadForkPath = async (
    context: QueryContext,
    args: { index?: number; messageId?: string; threadId: Id<"threads"> },
): Promise<{ index: number; rows: Doc<"messages">[] }> => {
    const thread = await context.db.get(args.threadId);

    if (!thread) {
        return { index: -1, rows: [] };
    }

    const path = await loadActivePath(context, args.threadId, thread.activeLeafMessageId);
    let target: { index: number } | { messageId: string } | undefined;

    if (args.messageId !== undefined) {
        target = { messageId: args.messageId };
    } else if (args.index !== undefined) {
        target = { index: args.index };
    }

    const end = forkEnd(
        path.map((row) => {
            return { _id: row._id as string, order: row.order, role: (row.message as { role?: string } | undefined)?.role };
        }),
        target,
    );

    if (!end) {
        return { index: -1, rows: [] };
    }

    return { index: end.index, rows: path.slice(0, path.findIndex((row) => row._id === end.endId) + 1) };
};

/**
 * Where a fork ends (`branchThread`): the last row it copies, and the display
 * position to record as `branchPoint`. `null` when the target is not on the
 * path or the thread is empty.
 */
export const resolveForkEnd = internalQuery
    .input(vForkTarget)
    .output(v.union(v.null(), v.object({ endId: v.id("messages"), index: v.number() })))
    .query(async ({ args, ctx }) => {
        const { index, rows } = await loadForkPath(ctx, args);
        const last = rows.at(-1);

        return last ? { endId: last._id, index } : null;
    });

/**
 * Every row a fork at `branchPoint` copied, top first — the parent's side of a
 * branch relationship, cut exactly where `branchThread` cut it.
 */
export const getForkContextIds = internalQuery
    .input(vForkTarget)
    .output(v.array(v.id("messages")))
    .query(async ({ args, ctx }) => {
        const { rows } = await loadForkPath(ctx, args);

        return rows.map((row) => row._id);
    });

/** The highest `order` in the thread, `-1` when it is empty. */
export const getMaxOrder = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.number())
    .query(async ({ args, ctx }) => {
        const last = await getMaxMessage(ctx, args.threadId);

        return last?.order ?? -1;
    });

/**
 * Points the thread at `messageId` without descending: a reply generated for
 * it afterwards is its latest child and so lands on the displayed path. Used
 * by regenerate, where the new reply does not exist yet.
 */
export const setActiveLeaf = internalMutation
    .input({ messageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.patch(args.threadId, { activeLeafMessageId: args.messageId });

        return null;
    });

/**
 * Saves an edited prompt as a SIBLING of the original — same parent, the
 * original and its replies untouched — and makes it the active leaf.
 */
export const saveEditedSibling = internalMutation
    .input({
        fileIds: v.optional(v.array(v.id("chatFiles"))),
        message: vMessage,
        originalMessageId: v.id("messages"),
        userId: v.string(),
    })
    .output(v.id("messages"))
    .mutation(async ({ args, ctx }) => await saveEditedSiblingHandler(ctx, args));

/** `saveEditedSibling`'s body, shared with the local-model path (`chat/local-models.ts`). */
export const saveEditedSiblingHandler = async (
    ctx: MutationContext,
    args: { fileIds?: Id<"chatFiles">[]; message: Message; originalMessageId: Id<"messages">; userId: string },
): Promise<Id<"messages">> => {
    const original = await ctx.db.get(args.originalMessageId);

    if (!original) {
        return throwBadRequest("Message not found");
    }

    const threadId = original.threadId as Id<"threads">;
    const parent = await parentOf(ctx, threadId, original);
    const { messages } = await addMessagesHandler(ctx, {
        messages: [{ fileIds: args.fileIds, message: args.message, status: "success" }],
        parentMessageId: parent?._id ?? BRANCH_ROOT,
        threadId,
        userId: args.userId,
    });
    const saved = messages[0];

    if (!saved) {
        return throwBadRequest("Failed to save the edited message");
    }

    const savedId = saved._id as Id<"messages">;

    await ctx.db.patch(threadId, { activeLeafMessageId: savedId });

    return savedId;
};

/**
 * The sibling switcher. Stores the leaf reached from `messageId` by latest
 * child, so the stored leaf is a real leaf and later replies extend it.
 */
export const switchBranch = authMutation
    .use(rateLimit("chat/update"))
    .input({ messageId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== ctx.user.userId) {
            throwForbidden("Cannot modify another user's thread");
        }

        admitOwnedThread(ctx, thread, ctx.user.userId);

        const target = await getThreadRow(ctx, args.threadId, args.messageId);

        if (!target) {
            return throwBadRequest("Message is not part of this thread");
        }

        const leaf = await descendFrom(ctx, args.threadId, target);

        await ctx.db.patch(args.threadId, { activeLeafMessageId: leaf._id });

        ctx.log.event("agent.switch_branch", { threadId: args.threadId, leafFound: true });

        return null;
    });
