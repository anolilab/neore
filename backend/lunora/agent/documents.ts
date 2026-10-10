/**
 * Document/Artifact operations.
 * Supports text (markdown), code, sheet (CSV), and image (base64) documents
 * created and edited by AI tools during chat.
 */
import { LunoraError, type Infer, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { authMutation, query, rateLimit } from "../lib/crpc";
import { getAuthUserIdentity } from "../auth";
import { assert } from "../lib/error-helpers";
import { withoutUndefined } from "../lib/patch";
import { admitOwnedThread } from "./thread-read-access";
import { assertJsonWithinLimit, MAX_LENGTH, vJsonValue } from "../lib/validators";

const vDocumentKind = v.union(v.literal("text"), v.literal("code"), v.literal("sheet"), v.literal("image"), v.literal("design"));

export const vDocumentDoc = v.object({
    _creationTime: v.number(),
    _id: v.string(),
    content: v.optional(v.string()),
    contentJson: v.optional(v.any()),
    kind: vDocumentKind,
    language: v.optional(v.string()),
    messageId: v.optional(v.string()),
    status: v.optional(v.union(v.literal("idle"), v.literal("streaming"))),
    threadId: v.string(),
    title: v.string(),
    userId: v.string(),
    version: v.number(),
});

export type DocumentDoc = Infer<typeof vDocumentDoc>;

const publicDocument = (documentRow: Doc<"documents">): DocumentDoc => {
    return {
        _creationTime: documentRow._creationTime,
        _id: documentRow._id,
        content: documentRow.content ?? undefined,
        contentJson: documentRow.contentJson ?? undefined,
        kind: documentRow.kind as "text" | "code" | "sheet" | "image" | "design",
        language: documentRow.language ?? undefined,
        messageId: documentRow.messageId ?? undefined,
        status: documentRow.status as "idle" | "streaming" | undefined,
        threadId: documentRow.threadId,
        title: documentRow.title,
        userId: documentRow.userId,
        version: documentRow.version,
    };
};

export const getDocument = query
    .input({ documentId: v.id("documents") })
    .output(v.from(v.union(vDocumentDoc, v.null())))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const documentRow = await ctx.db.get(args.documentId);

        if (!documentRow || documentRow.userId !== identity.userId) {
            return null;
        }

        return publicDocument(documentRow);
    });

export const getDocumentInternal = internalQuery
    .input({ documentId: v.id("documents") })
    .output(v.from(v.union(vDocumentDoc, v.null())))
    .query(async ({ args, ctx }) => {
        const documentRow = await ctx.db.get(args.documentId);

        if (!documentRow) {
            return null;
        }

        return publicDocument(documentRow);
    });

export const getDocumentsByThread = query
    .input({ threadId: v.id("threads") })
    .output(v.from(v.array(vDocumentDoc)))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return [];
        }

        const thread = await ctx.db.get(args.threadId);

        if (!thread || thread.userId !== identity.userId) {
            return [];
        }

        admitOwnedThread(ctx, thread, identity.userId);

        const docs = await ctx.db
            .query("documents")
            .withIndex("by_threadId_and_kind", (q) => q.eq("threadId", args.threadId))
            .take(200);

        return docs.map((item) => publicDocument(item));
    });

export const getDocumentByMessage = query
    .input({ messageId: v.string().max(MAX_LENGTH.id) })
    .output(v.from(v.union(vDocumentDoc, v.null())))
    .query(async ({ args, ctx }) => {
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            return null;
        }

        const documentRow = await ctx.db
            .query("documents")
            .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
            .first();

        if (!documentRow || documentRow.userId !== identity.userId) {
            return null;
        }

        return publicDocument(documentRow);
    });

export const createDocument = internalMutation
    .input({
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        kind: vDocumentKind,
        language: v.optional(v.string()),
        messageId: v.optional(v.string()),
        threadId: v.id("threads"),
        title: v.string(),
        userId: v.string(),
    })
    .output(v.from(vDocumentDoc))
    .mutation(async ({ args, ctx }) => {
        const insertedId = await ctx.db.insert("documents", {
            ...args,
            status: "idle",
            version: 1,
        });
        const documentId = insertedId as Id<"documents">;

        const documentRow = await ctx.db.get(documentId);

        assert(documentRow, `Document ${documentId} not found after creation`);

        return publicDocument(documentRow);
    });

export const updateDocument = authMutation
    .use(rateLimit("documents/update"))
    .input({
        commit: v.optional(v.object({ changes: v.number(), timestamp: v.number() })),
        content: v.optional(v.string().max(MAX_LENGTH.document)),
        contentJson: v.optional(vJsonValue),
        documentId: v.id("documents"),
        language: v.optional(v.string().max(MAX_LENGTH.short)),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.from(vDocumentDoc))
    .mutation(async ({ args, ctx }) => {
        assertJsonWithinLimit(args.contentJson, "contentJson");
        assertJsonWithinLimit(args.commit, "commit");
        const identity = await getAuthUserIdentity(ctx);

        if (!identity) {
            throw new LunoraError("UNAUTHORIZED", "Not authenticated");
        }

        const documentRow = await ctx.db.get(args.documentId);

        assert(documentRow, `Document ${args.documentId} not found`);

        if (documentRow.userId !== identity.userId) {
            throw new LunoraError("FORBIDDEN", "Forbidden");
        }

        const patch: Partial<Doc<"documents">> = {};

        if (args.title !== undefined) {
            patch.title = args.title;
        }

        if (args.content !== undefined) {
            patch.content = args.content;
        }

        if (args.contentJson !== undefined) {
            patch.contentJson = args.contentJson;
        }

        if (args.language !== undefined) {
            patch.language = args.language;
        }

        // Snapshot current state into documentVersions before overwriting content.
        // Record the actual modifier (identity.userId), not the document owner — so
        // co-editors with shared access remain attributable in the audit trail.
        if (args.content !== undefined || args.contentJson !== undefined) {
            await ctx.db.insert("documentVersions", {
                commit: args.commit,
                content: documentRow.content,
                contentJson: documentRow.contentJson,
                createdAt: ctx.now,
                documentId: args.documentId,
                userId: identity.userId,
                version: documentRow.version,
            });
            patch.version = documentRow.version + 1;
        }

        await ctx.db.patch(args.documentId, withoutUndefined(patch));
        const updated = await ctx.db.get(args.documentId);

        assert(updated, `Document ${args.documentId} not found after update`);

        ctx.log.event("agent.update_document", {
            documentId: args.documentId,
            hasContent: args.content !== undefined,
            hasContentJson: args.contentJson !== undefined,
            hasTitle: args.title !== undefined,
            version: updated.version,
        });

        return publicDocument(updated);
    });

export const updateDocumentInternal = internalMutation
    .input({
        callerThreadId: v.optional(v.string()),
        commit: v.optional(v.any()),
        content: v.optional(v.string()),
        contentJson: v.optional(v.any()),
        documentId: v.id("documents"),
        language: v.optional(v.string()),
        messageId: v.optional(v.string()),
        status: v.optional(v.union(v.literal("idle"), v.literal("streaming"))),
        title: v.optional(v.string()),
    })
    .output(v.from(vDocumentDoc))
    .mutation(async ({ args, ctx }) => {
        const documentRow = await ctx.db.get(args.documentId);

        assert(documentRow, `Document ${args.documentId} not found`);

        // If callerThreadId is provided, verify the document belongs to that thread
        if (args.callerThreadId && documentRow.threadId && documentRow.threadId !== args.callerThreadId) {
            throw new LunoraError("FORBIDDEN", "Cannot update document: it belongs to a different thread");
        }

        const patch: Partial<Doc<"documents">> = {};

        if (args.title !== undefined) {
            patch.title = args.title;
        }

        if (args.content !== undefined) {
            patch.content = args.content;
        }

        if (args.contentJson !== undefined) {
            patch.contentJson = args.contentJson;
        }

        if (args.language !== undefined) {
            patch.language = args.language;
        }

        if (args.messageId !== undefined) {
            patch.messageId = args.messageId;
        }

        if (args.status !== undefined) {
            patch.status = args.status;
        }

        // Snapshot current state into documentVersions before overwriting content
        if (args.content !== undefined || args.contentJson !== undefined) {
            await ctx.db.insert("documentVersions", {
                commit: args.commit,
                content: documentRow.content,
                contentJson: documentRow.contentJson,
                createdAt: ctx.now,
                documentId: args.documentId,
                userId: documentRow.userId,
                version: documentRow.version,
            });
            patch.version = documentRow.version + 1;
        }

        await ctx.db.patch(args.documentId, withoutUndefined(patch));
        const updated = await ctx.db.get(args.documentId);

        assert(updated, `Document ${args.documentId} not found after update`);

        ctx.log.event("agent.update_document", {
            documentId: args.documentId,
            hasContent: args.content !== undefined,
            hasContentJson: args.contentJson !== undefined,
            hasTitle: args.title !== undefined,
            version: updated.version,
        });

        return publicDocument(updated);
    });

export const deleteDocument = internalMutation
    .input({ documentId: v.id("documents") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const documentRow = await ctx.db.get(args.documentId);

        assert(documentRow, `Document ${args.documentId} not found`);
        await ctx.db.delete(args.documentId);

        return null;
    });
