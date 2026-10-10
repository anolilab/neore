/**
 * Page comments: threads anchored to a text selection.
 *
 * A thread's ROOT row carries `commentId` — the id of the `comment` mark on the
 * selected text — and the quote (`anchorText`); replies point at the root with
 * `parentId`. Anchors are kept honest by `writeContent` (`functions.ts`), which
 * re-anchors or orphans them on every content write.
 *
 * Commenting needs the `comment` permission. Adding the anchor mark IS a content
 * write, so `createPageComment` takes the editor's document with the mark
 * applied — and a caller without `write` may only change comment marks: the
 * document must otherwise equal what is stored (`sameContentIgnoringComments`).
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { parentKeyOf } from "../lib/rls/scope";
import { requirePageAccess, resolvePageAccess } from "./access";
import { collectCommentAnchors, sameContentIgnoringComments } from "./comment-anchors";
import { assertFreshRevision, writeContent } from "./functions";
import { COMMENT_BODY_MAX, MAX_COMMENTS_PER_PAGE, meetsPagePermission } from "./logic";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonValue } from "../lib/validators";

const COMMENT_ID_MAX = 64;
const ANCHOR_TEXT_MAX = 2000;

const vCommentEntry = v.object({
    _id: v.id("pageComments"),
    authorName: v.string(),
    body: v.string(),
    createdAt: v.number(),
    editedAt: v.union(v.number(), v.null()),
    isOwn: v.boolean(),
});

const vCommentThreads = v.array(
    v.object({
        _id: v.id("pageComments"),
        anchorText: v.union(v.string(), v.null()),
        authorName: v.string(),
        body: v.string(),
        commentId: v.string(),
        createdAt: v.number(),
        editedAt: v.union(v.number(), v.null()),
        isOwn: v.boolean(),
        orphaned: v.boolean(),
        replies: v.array(vCommentEntry),
        resolvedAt: v.union(v.number(), v.null()),
        status: v.union(v.literal("open"), v.literal("resolved")),
    }),
);

const requireBody = (body: string): string => {
    const trimmed = body.trim();

    if (trimmed.length === 0) {
        throw new LunoraError("BAD_REQUEST", "A comment cannot be empty");
    }

    if (trimmed.length > COMMENT_BODY_MAX) {
        throw new LunoraError("BAD_REQUEST", `A comment must be under ${String(COMMENT_BODY_MAX)} characters`);
    }

    return trimmed;
};

const loadPageComments = async (ctx: Pick<QueryCtx, "db">, pageId: Id<"pages">): Promise<Doc<"pageComments">[]> =>
    await ctx.db
        .query("pageComments")
        .withIndex("by_page_and_created", (q) => q.eq("pageId", pageId))
        .take(MAX_COMMENTS_PER_PAGE);

/** The root row of the thread `commentRowId` belongs to, with the caller's page access. */
const loadThreadRoot = async (ctx: MutationCtx, commentRowId: Id<"pageComments">, userId: string) => {
    // Admit the page first: another author's comment is invisible until then.
    const pageId = await parentKeyOf(ctx, commentRowId, "pageId");

    if (pageId) {
        await resolvePageAccess(ctx, pageId as Id<"pages">, userId);
    }

    const row = await ctx.db.get(commentRowId);

    if (!row) {
        throw new LunoraError("NOT_FOUND", "Comment not found");
    }

    const root = row.parentId ? await ctx.db.get(row.parentId) : row;

    if (!root) {
        throw new LunoraError("NOT_FOUND", "Comment not found");
    }

    const access = await requirePageAccess(ctx, root.pageId, userId, "comment");

    return { access, root, row };
};

export const listPageComments = authQuery
    .input({ pageId: v.id("pages") })
    .output(v.from(vCommentThreads))
    .query(async ({ args: { pageId }, ctx }): Promise<Infer<typeof vCommentThreads>> => {
        await requirePageAccess(ctx, pageId, ctx.user.userId, "read");

        const rows = await loadPageComments(ctx, pageId);
        const { userId } = ctx.user;

        return rows
            .filter((row) => row.parentId === undefined)
            .map((root) => {
                return {
                    _id: root._id,
                    anchorText: root.anchorText ?? null,
                    authorName: root.authorName,
                    body: root.body,
                    commentId: root.commentId,
                    createdAt: root.createdAt,
                    editedAt: root.editedAt ?? null,
                    isOwn: root.userId === userId,
                    orphaned: root.orphaned === true,
                    replies: rows
                        .filter((reply) => reply.parentId === root._id)
                        .map((reply) => {
                            return {
                                _id: reply._id,
                                authorName: reply.authorName,
                                body: reply.body,
                                createdAt: reply.createdAt,
                                editedAt: reply.editedAt ?? null,
                                isOwn: reply.userId === userId,
                            };
                        }),
                    resolvedAt: root.resolvedAt ?? null,
                    status: root.status,
                };
            });
    });

/**
 * Starts a thread on a selection. `contentJson` is the editor's document with
 * the `comment` mark for `commentId` already applied; it is stored in the same
 * transaction, so the thread and its anchor land together.
 */
export const createPageComment = authMutation
    .use(rateLimit("pages/comment"))
    .input({
        baseRevision: v.number(),
        body: v.string().max(MAX_LENGTH.document),
        commentId: v.string().max(MAX_LENGTH.id),
        content: v.optional(v.string().max(MAX_LENGTH.document)),
        contentJson: v.optional(vJsonValue),
        pageId: v.id("pages"),
    })
    .output(v.object({ commentRowId: v.id("pageComments"), contentJson: v.optional(v.any()), revision: v.number() }))
    .mutation(async ({ args, ctx }) => {
        assertJsonWithinLimit(args.contentJson, "contentJson");
        const { userId } = ctx.user;
        const { page, permission } = await requirePageAccess(ctx, args.pageId, userId, "comment");
        const body = requireBody(args.body);

        if (args.commentId.length === 0 || args.commentId.length > COMMENT_ID_MAX) {
            throw new LunoraError("BAD_REQUEST", "Invalid comment id");
        }

        const anchorText = collectCommentAnchors(args.contentJson).get(args.commentId);

        if (!anchorText) {
            throw new LunoraError("BAD_REQUEST", "Select some text to comment on");
        }

        // Before the content check: a commenter behind a collaborator's edit has a
        // stale document, which is a conflict to reload, not a forbidden edit.
        assertFreshRevision(page, args.baseRevision);

        if (!meetsPagePermission(permission, "write") && !sameContentIgnoringComments(page.contentJson, args.contentJson)) {
            throw new LunoraError("FORBIDDEN", "You can comment on this page but not edit it");
        }

        const existing = await loadPageComments(ctx, args.pageId);

        if (existing.length >= MAX_COMMENTS_PER_PAGE) {
            throw new LunoraError("BAD_REQUEST", "This page has too many comments");
        }

        if (existing.some((row) => row.commentId === args.commentId)) {
            throw new LunoraError("CONFLICT", "Comment already exists");
        }

        const commentRowId = await ctx.db.insert("pageComments", {
            anchorText: anchorText.slice(0, ANCHOR_TEXT_MAX),
            authorName: ctx.user.name || "Anonymous",
            body,
            commentId: args.commentId,
            createdAt: ctx.now,
            pageId: args.pageId,
            status: "open",
            userId,
        });

        const written = await writeContent(ctx, page, {
            authorId: userId,
            baseRevision: args.baseRevision,
            // A commenter's markdown is not trusted over the stored one: only the marks changed.
            content: meetsPagePermission(permission, "write") ? args.content : page.content,
            contentJson: args.contentJson,
            reason: "edit",
        });

        ctx.log.event("pages.create_page_comment", { hasContentJson: args.contentJson !== undefined, revision: written.revision });

        return { commentRowId, contentJson: written.contentJson ?? undefined, revision: written.revision };
    });

export const replyToPageComment = authMutation
    .use(rateLimit("pages/comment"))
    .input({ body: v.string().max(MAX_LENGTH.document), commentRowId: v.id("pageComments") })
    .output(v.object({ commentRowId: v.id("pageComments") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const { root } = await loadThreadRoot(ctx, args.commentRowId, userId);
        const body = requireBody(args.body);
        const existing = await loadPageComments(ctx, root.pageId);

        if (existing.length >= MAX_COMMENTS_PER_PAGE) {
            throw new LunoraError("BAD_REQUEST", "This page has too many comments");
        }

        const commentRowId = await ctx.db.insert("pageComments", {
            authorName: ctx.user.name || "Anonymous",
            body,
            commentId: root.commentId,
            createdAt: ctx.now,
            pageId: root.pageId,
            parentId: root._id,
            status: "open",
            userId,
        });

        ctx.log.event("pages.reply_to_page_comment", { isReply: true });

        return { commentRowId };
    });

export const setPageCommentStatus = authMutation
    .use(rateLimit("pages/comment"))
    .input({ commentRowId: v.id("pageComments"), status: v.union(v.literal("open"), v.literal("resolved")) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const { root } = await loadThreadRoot(ctx, args.commentRowId, userId);

        await patchRow(
            ctx.db,
            root,
            args.status === "resolved"
                ? { resolvedAt: ctx.now, resolvedBy: userId, status: "resolved" }
                : { resolvedAt: undefined, resolvedBy: undefined, status: "open" },
        );

        ctx.log.event("pages.set_page_comment_status", { status: args.status });

        return null;
    });

export const editPageComment = authMutation
    .use(rateLimit("pages/comment"))
    .input({ body: v.string().max(MAX_LENGTH.document), commentRowId: v.id("pageComments") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { row } = await loadThreadRoot(ctx, args.commentRowId, ctx.user.userId);

        if (row.userId !== ctx.user.userId) {
            throw new LunoraError("FORBIDDEN", "Only the author can edit a comment");
        }

        await ctx.db.patch(row._id, { body: requireBody(args.body), editedAt: ctx.now });

        ctx.log.event("pages.edit_page_comment", { edited: true });

        return null;
    });

/**
 * Deletes one comment — the author's own, or anyone's for a page admin.
 * Deleting a root deletes its replies and strips its anchor mark from the stored
 * page in the same transaction, whatever the deleter's permission: it is their
 * own mark. The strip is derived from the stored page, so it needs no base
 * revision, and being marks-only it does not make other editors' saves stale.
 * Answers with the page's new revision (`null` when no page write happened).
 */
export const deletePageComment = authMutation
    .use(rateLimit("pages/comment"))
    .input({ commentRowId: v.id("pageComments") })
    .output(v.object({ revision: v.union(v.number(), v.null()) }))
    .mutation(async ({ args, ctx }) => {
        const { access, root, row } = await loadThreadRoot(ctx, args.commentRowId, ctx.user.userId);

        if (row.userId !== ctx.user.userId && !meetsPagePermission(access.permission, "admin")) {
            throw new LunoraError("FORBIDDEN", "Only the author or a page admin can delete a comment");
        }

        if (row._id === root._id) {
            const rows = await loadPageComments(ctx, root.pageId);
            const replies = rows.filter((reply) => reply.parentId === root._id);

            for (const reply of replies) {
                await ctx.db.delete(reply._id);
            }
        }

        await ctx.db.delete(row._id);

        if (row._id !== root._id || !collectCommentAnchors(access.page.contentJson).has(root.commentId)) {
            return { revision: null };
        }

        // The thread row is gone, so `writeContent` strips its now-dead mark.
        const written = await writeContent(ctx, access.page, {
            authorId: ctx.user.userId,
            baseRevision: null,
            content: access.page.content,
            contentJson: access.page.contentJson,
            reason: "edit",
        });

        ctx.log.event("pages.delete_page_comment", { deletedReplies: row._id === root._id, revision: written.revision });

        return { revision: written.revision };
    });
