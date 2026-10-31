import type { PaginationResult } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx as QueryContext } from "../_generated/server";
import { authMutation, rateLimit } from "../lib/crpc";
import { throwBadRequest, throwForbidden, throwThreadNotFound } from "../lib/error-helpers";
import { regenerateParentOf, syncActiveAgent } from "./agent-switch";
import { agentSwitchOf } from "./agent-switch-logic";
import { childrenOf, contextPathIds, descendFrom, getThreadRow, loadActivePath, parentOf, resolveLeafRow, walkPath } from "./branch-rows";
import type { MessageBranch } from "./branch-tree";
import { BRANCH_ROOT, forkEnd, messageRowsOf } from "./branch-tree";
import { addMessagesHandler, getMaxMessage } from "./messages";
import { requireOwnedThread } from "./thread-read-access";
import { isLockedWithoutProof } from "./thread-passcode";
import { type ReplyContent, rewriteReplyText } from "./reply-edit";
import { extractText } from "./shared";
import type { Message } from "./validators";
import { vMessage } from "./validators";
import { patchRow } from "../lib/patch";
import { dropSummariesFromEdit } from "./thread-summaries";
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
 * The replies the switcher offers under `parent` (`null` = the top level): its children, with each agent-switch
 * divider replaced by what hangs under it. A regenerate after a switch hangs its reply under a divider
 * (`regenerateParentOf`), and the divider is no alternative to show — the reply under it is. A divider
 * with nothing under it yet stays in the list.
 */
const alternativesUnder = async (context: QueryContext, threadId: Id<"threads">, parent: Doc<"messages"> | null): Promise<Doc<"messages">[]> => {
    const alternatives: Doc<"messages">[] = [];
    const children = await childrenOf(context, threadId, parent);

    for (const child of children) {
        const below = agentSwitchOf(child) ? await alternativesUnder(context, threadId, child) : [];

        alternatives.push(...(below.length > 0 ? below : [child]));
    }

    return alternatives;
};

const isPrompt = (row: Doc<"messages">): boolean => (row.message as { role?: string } | undefined)?.role === "user";

/**
 * The alternatives `row` is one of: those under its nearest ancestor that is not a divider, of the same kind
 * as `row`. A prompt sent after a switch hangs under the divider too, and it is the next turn, not a version
 * of a reply regenerated there.
 */
const siblingsOf = async (context: QueryContext, threadId: Id<"threads">, row: Doc<"messages">, parent: Doc<"messages"> | null): Promise<Doc<"messages">[]> => {
    let anchor = parent;

    while (anchor && agentSwitchOf(anchor)) {
        anchor = await parentOf(context, threadId, anchor);
    }

    const alternatives = await alternativesUnder(context, threadId, anchor);

    return alternatives.filter((alternative) => isPrompt(alternative) === isPrompt(row));
};

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
    unlockProof?: string | null,
    // Callers that never show the switcher (the prompt outline) skip one sibling read per row.
    withSiblings = true,
): Promise<(PaginationResult<Doc<"messages">> & { branches: Map<string, MessageBranch> }) | null> => {
    if (!thread.activeLeafMessageId) {
        return null;
    }

    // A locked thread's path is its content: without the proof it reads as unbranched
    // (`null`), and the caller's linear read is refused the same way.
    if (await isLockedWithoutProof(context, thread._id as Id<"threads">, unlockProof)) {
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
    if (withSiblings) {
        await Promise.all(
            rows.map(async (row, index) => {
                const siblings = await siblingsOf(context, threadId, row, rows[index + 1] ?? next);
                const position = siblings.findIndex((sibling) => sibling._id === row._id);

                if (siblings.length > 1 && position !== -1) {
                    branches.set(row._id, {
                        count: siblings.length,
                        index: position,
                        siblingIds: siblings.map((sibling) => sibling._id as string),
                    });
                }
            }),
        );
    }

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
 * by regenerate, where the new reply does not exist yet. A regenerate of the
 * newest turn that runs on a switched agent (`runModel`) points at a divider
 * under the prompt instead, so the branch keeps that agent (`regenerateParentOf`).
 */
export const setActiveLeaf = internalMutation
    .input({ messageId: v.id("messages"), runModel: v.optional(v.string().max(MAX_LENGTH.short)), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await setActiveLeafHandler(ctx, args);

        return null;
    });

/** `setActiveLeaf`'s body, so the harness can drive it. */
export const setActiveLeafHandler = async (
    ctx: MutationContext,
    args: { messageId: Id<"messages">; runModel?: string; threadId: Id<"threads"> },
): Promise<void> => {
    const thread = await ctx.db.get(args.threadId);
    const leafId = thread ? await regenerateParentOf(ctx, thread, args.messageId, args.runModel) : args.messageId;

    await ctx.db.patch(args.threadId, { activeLeafMessageId: leafId });
    await syncActiveAgent(ctx, args.threadId, leafId);
};

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
        fromUser: true,
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
    await syncActiveAgent(ctx, threadId, savedId);

    return savedId;
};

/** The stored `message` of a row, typed for the reply helpers. */
const messageOf = (row: Doc<"messages">): { content: ReplyContent; role: string } | undefined =>
    row.message as { content: ReplyContent; role: string } | undefined;

/**
 * Replaces the visible text of an assistant reply, in place: no model call, no
 * credit charge, and no row is inserted, so a repeated save writes nothing new.
 * The reply is the displayed message containing `messageId` (`messageRowsOf`),
 * which keeps sibling replies that share its `order` untouched. Tool calls,
 * reasoning and media stay as they were (`reply-edit.ts`).
 */
export const editAssistantReply = authMutation
    .use(rateLimit("chat/update"))
    .input({
        messageId: v.string().max(MAX_LENGTH.id),
        text: v.string().max(MAX_LENGTH.document),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => await editAssistantReplyHandler(ctx, { ...args, userId: ctx.user.userId }));

/** `editAssistantReply`'s body, with the caller passed in so the harness can drive it. */
export const editAssistantReplyHandler = async (
    ctx: MutationContext,
    args: { messageId: string; text: string; threadId: Id<"threads">; unlockProof?: string; userId: string },
): Promise<null> => {
    const thread = await ctx.db.get(args.threadId);

    if (!thread) {
        return throwThreadNotFound();
    }

    // The same owner-only rule as editing a prompt (`/chat/edit`).
    if (thread.userId !== args.userId) {
        throwForbidden("Cannot modify another user's thread");
    }

    // Lock-aware: a locked thread's reply text is not editable without its proof.
    await requireOwnedThread(ctx, args.threadId, args.userId, args.unlockProof);

    const text = args.text.trim();

    if (!text) {
        return throwBadRequest("The reply text is empty");
    }

    const path = await loadActivePath(ctx, args.threadId, thread.activeLeafMessageId);
    const pathRows = path.map((row) => {
        return { _id: row._id as string, doc: row, order: row.order, role: messageOf(row)?.role };
    });
    const reply = messageRowsOf(pathRows, args.messageId)?.map((entry) => entry.doc);

    if (!reply) {
        return throwBadRequest("Message is not on the displayed path");
    }

    if (reply.some((row) => row.status !== "success")) {
        return throwBadRequest("The reply has not finished");
    }

    const changes = rewriteReplyText(
        reply.map((row) => {
            return { content: messageOf(row)?.content ?? "", role: messageOf(row)?.role ?? "" };
        }),
        text,
    );

    if (!changes) {
        return throwBadRequest("This message has no text to edit");
    }

    for (const [index, row] of reply.entries()) {
        const content = changes[index];

        if (content === undefined) {
            continue;
        }

        const message = { ...messageOf(row), content } as Message;
        // `text` is the search copy of the message; a row hidden from search has none, and stays so.
        const patch: { embeddingId?: undefined; message: Message; text?: string } = { message };

        if (row.text !== undefined) {
            patch.text = extractText(message);
        }

        // The stored vector embeds the old text, so it would surface the old reply in search.
        if (row.embeddingId) {
            await ctx.db.delete(row.embeddingId as Id<"embeddings_1536">);
            patch.embeddingId = undefined;
        }

        await patchRow(ctx.db, row, patch);
    }

    // A summary covering the edited turns may quote the old text, and a run under way has read it (`thread-summaries.ts`).
    await dropSummariesFromEdit(ctx, args.threadId, Math.min(...reply.map((row) => row.order)));

    return null;
};

/**
 * The sibling switcher. Stores the leaf reached from `messageId` by latest
 * child, so the stored leaf is a real leaf and later replies extend it.
 */
export const switchBranch = authMutation
    .use(rateLimit("chat/update"))
    .input({
        messageId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const thread = await ctx.db.get(args.threadId);

        if (!thread) {
            return throwThreadNotFound();
        }

        if (thread.userId !== ctx.user.userId) {
            throwForbidden("Cannot modify another user's thread");
        }

        await requireOwnedThread(ctx, args.threadId, ctx.user.userId, args.unlockProof);

        const target = await getThreadRow(ctx, args.threadId, args.messageId);

        if (!target) {
            return throwBadRequest("Message is not part of this thread");
        }

        const leaf = await descendFrom(ctx, args.threadId, target);

        await ctx.db.patch(args.threadId, { activeLeafMessageId: leaf._id });
        await syncActiveAgent(ctx, args.threadId, leaf._id);

        ctx.log.event("agent.switch_branch", { leafFound: true, threadId: args.threadId });

        return null;
    });
