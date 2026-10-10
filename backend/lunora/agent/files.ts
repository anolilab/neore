/**
 * File operations for chat attachments.
 * Migrated from `@neore/backend-agent` component.
 *
 * NOTE: Table renamed from 'files' to 'chatFiles' to avoid conflict with vault/files table.
 */
import type { InferArgs } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx as MutationContext } from "../_generated/server";
import { checkThreadAccessBatchHandler } from "./threads";
import { paginatedDocsOf } from "../lib/output-validators";
import { paginationOptionsValidator } from "../lib/validators";
import { patchRow, withoutUndefined } from "../lib/patch";
import { ownedStorageKeys } from "../lib/storage-ownership";

/**
 * `.input()` takes the field RECORD, and `InferArgs` reads that same record, so
 * the validator and the handler's arg type cannot drift.
 */
const addFileFields = {
    filename: v.optional(v.string()),
    hash: v.string(),
    mediaType: v.string(),
    storageId: v.string(),
    /** The user storing the bytes; gets an access grant (`chatFileAccess`). */
    userId: v.optional(v.string()),
};

/** Rows scanned for one hash when no filename narrows it (one per filename the bytes were stored under). */
const HASH_ROWS_LIMIT = 50;

/**
 * The `chatFiles` row for these bytes under this name (`.global()`, D1). With
 * no `filename`, the row stored without one.
 */
const findChatFile = async (context: Pick<MutationContext, "db">, hash: string, filename: string | undefined) => {
    if (filename) {
        return await context.db.chatFiles.findFirst({ where: { filename, hash } });
    }

    const { page } = await context.db.chatFiles.findMany({ limit: HASH_ROWS_LIMIT, where: { hash } });

    return page.find((row) => row.filename === undefined) ?? null;
};

/** Record that `userId` may attach `fileId`. Idempotent. */
export const grantFileAccess = async (context: MutationContext, fileId: Id<"chatFiles">, userId: string | undefined): Promise<void> => {
    if (!userId) {
        return;
    }

    const existing = await context.db.chatFileAccess.findFirst({ where: { fileId, userId } });

    if (!existing) {
        await context.db.insert("chatFileAccess", { createdAt: Date.now(), fileId, userId });
    }
};

/**
 * Grant a thread's owner access to media stored for it (`storeFile({ threadId })`).
 * A `threadId` that names no thread (a workflow run passes `"workflow"`) grants
 * nothing.
 */
export const grantThreadOwnerAccess = internalMutation
    .input({ fileId: v.id("chatFiles"), threadId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // `get` throws on a malformed id; that names no thread either.
        const thread: { userId?: string } | null = await ctx.db.get(args.threadId as Id<"threads">).catch(() => null);

        await grantFileAccess(ctx, args.fileId, thread?.userId);

        return null;
    });

export const addFile = internalMutation
    .input(addFileFields)
    .output(
        v.object({
            fileId: v.id("chatFiles"), // RENAMED: files -> chatFiles
            storageId: v.string(),
        }),
    )
    .mutation(async ({ args, ctx }) => await addFileHandler(ctx, args));

export async function addFileHandler(context: MutationContext, args: InferArgs<typeof addFileFields>) {
    // Use compound index when filename is provided, otherwise use hash index
    const existingFile = await findChatFile(context, args.hash, args.filename);

    if (existingFile) {
        // increment the refcount
        await context.db.patch(existingFile._id, {
            lastTouchedAt: Date.now(),
            refcount: existingFile.refcount + 1,
        });
        await grantFileAccess(context, existingFile._id, args.userId);

        return {
            fileId: existingFile._id,
            storageId: existingFile.storageId,
        };
    }

    const insertedId = await context.db.insert("chatFiles", {
        extractionStatus: "pending",
        filename: args.filename,
        hash: args.hash,
        lastTouchedAt: Date.now(),
        mediaType: args.mediaType,
        // We start out with it unused - when it's saved in a message we increment.
        refcount: 0,
        storageId: args.storageId,
    });
    const fileId = insertedId as Id<"chatFiles">;

    await grantFileAccess(context, fileId, args.userId);

    return {
        fileId,
        storageId: args.storageId,
    };
}

/**
 * Messages scanned per thread when a file is attached through the thread
 * rather than an own grant. A file older than this in a long thread must be
 * re-uploaded; the uploader's own grant never expires.
 */
const THREAD_FILE_SCAN_LIMIT = 1000;

/**
 * The file, if `userId` may attach it: they stored the bytes themselves
 * (a `chatFileAccess` grant), or it is already attached to a message in
 * `threadId` and they can read that thread. `null` otherwise — the same
 * answer as a file that does not exist.
 *
 * This replaced a PUBLIC `get` query that returned any file row, extracted
 * text included, to anyone holding its id, and a `/chat/start` that attached
 * whatever ids the request named.
 */
export const getFileForUser = internalQuery
    .input({
        fileId: v.id("chatFiles"),
        threadId: v.optional(v.id("threads")),
        userId: v.string(),
    })
    // Spelled inline: codegen cannot read `docOf(...)` (a call), and the
    // generated reference then types the result `unknown`.
    .output(
        v.union(
            v.object({
                _id: v.id("chatFiles"),
                extractedText: v.optional(v.string()),
                extractionStatus: v.optional(
                    v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("unsupported")),
                ),
                filename: v.optional(v.string()),
                hash: v.string(),
                mediaType: v.string(),
                storageId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const row = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });
        const file = row
            ? {
                  _id: row._id,
                  extractedText: row.extractedText,
                  extractionStatus: row.extractionStatus,
                  filename: row.filename,
                  hash: row.hash,
                  mediaType: row.mediaType,
                  storageId: row.storageId,
              }
            : null;

        if (!file) {
            return null;
        }

        const grant = await ctx.db.chatFileAccess.findFirst({ where: { fileId: args.fileId, userId: args.userId } });

        if (grant) {
            return file;
        }

        if (!args.threadId) {
            return null;
        }

        const access = await checkThreadAccessBatchHandler(ctx, { requiredPermission: "read", threadId: args.threadId, userId: args.userId });

        if (!access.hasAccess) {
            return null;
        }

        const messages = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", args.threadId!))
            .order("desc")
            .take(THREAD_FILE_SCAN_LIMIT);

        return messages.some((message) => message.fileIds?.includes(args.fileId)) ? file : null;
    });

/** `fileId → storage key` for a batch of files (`agent/stored-media.ts`). Missing files are omitted. */
export const getStorageKeys = internalQuery
    .input({ fileIds: v.array(v.id("chatFiles")) })
    .output(v.record(v.string(), v.string()))
    .query(async ({ args, ctx }) => {
        const files = await Promise.all(args.fileIds.map(async (fileId) => await ctx.db.chatFiles.findFirst({ where: { _id: fileId } })));

        return Object.fromEntries(files.filter((file) => file !== null).map((file) => [file._id as string, file.storageId]));
    });

/**
 * The subset of `keys` that `userId` owns (`lib/storage-ownership.ts`): what a
 * tool result in their message may have signed (`agent/stored-media.ts`).
 */
export const getOwnedStorageKeys = internalQuery
    .input({ keys: v.array(v.string()), userId: v.string() })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => [...(await ownedStorageKeys(ctx.db, args.userId, args.keys))]);

export const useExistingFile = internalMutation
    .input({
        filename: v.optional(v.string()),
        hash: v.string(),
        /** Proved possession of the bytes (it just hashed them): grant access. */
        userId: v.optional(v.string()),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                fileId: v.id("chatFiles"), // RENAMED: files -> chatFiles
                storageId: v.string(),
            }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        // Use compound index when filename is provided, otherwise use hash index
        const file = await findChatFile(ctx, args.hash, args.filename);

        if (!file) {
            return null;
        }

        await ctx.db.patch(file._id, { lastTouchedAt: ctx.now });
        await grantFileAccess(ctx, file._id, args.userId);

        return { fileId: file._id, storageId: file.storageId };
    });

export const changeRefcount = async (context: MutationContext, previous: Id<"chatFiles">[], next: Id<"chatFiles">[]) => {
    const previousSet = new Set(previous);
    const nextSet = new Set(next);

    for (const fileId of previousSet) {
        if (nextSet.has(fileId)) {
            continue;
        }

        const file = await context.db.chatFiles.findFirst({ where: { _id: fileId } });

        if (file) {
            await context.db.patch(fileId, { refcount: file.refcount - 1 });
        } else {
            console.error(`File ${fileId} not found when decrementing refcount`);
        }
    }

    for (const fileId of nextSet) {
        if (previousSet.has(fileId)) {
            continue;
        }

        const file = await context.db.chatFiles.findFirst({ where: { _id: fileId } });

        if (file) {
            await context.db.patch(fileId, { refcount: file.refcount + 1 });
        } else {
            throw new Error(`File ${fileId} not found when incrementing refcount`);
        }
    }
};

export const copyFile = internalMutation
    .input({
        fileId: v.id("chatFiles"), // RENAMED: files -> chatFiles
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => await copyFileHandler(ctx, args));

export async function copyFileHandler(context: MutationContext, args: { fileId: Id<"chatFiles"> }): Promise<null> {
    const file = await context.db.chatFiles.findFirst({ where: { _id: args.fileId } });

    if (!file) {
        throw new Error("File not found");
    }

    await context.db.patch(args.fileId, {
        lastTouchedAt: Date.now(),
        refcount: file.refcount + 1,
    });

    return null;
}

export const getFilesToDelete = internalQuery
    .input({
        paginationOpts: paginationOptionsValidator,
    })
    .output(paginatedDocsOf("chatFiles"))
    .query(async ({ args, ctx }) => {
        const page = await ctx.db.chatFiles.findMany({
            cursor: args.paginationOpts.cursor,
            limit: args.paginationOpts.numItems,
            orderBy: [{ _creationTime: "asc" }],
            where: { refcount: 0 },
        });

        return { continueCursor: page.continueCursor, isDone: page.isDone, page: page.page };
    });

export const deleteFiles = internalMutation
    .input({
        fileIds: v.array(v.id("chatFiles")), // RENAMED: files -> chatFiles
        force: v.optional(v.boolean()),
    })
    .output(v.array(v.id("chatFiles")))
    .mutation(async ({ args, ctx }) => {
        const deletedFileIds = await Promise.all(
            args.fileIds.map(async (fileId) => {
                const file = await ctx.db.chatFiles.findFirst({ where: { _id: fileId } });

                if (!file) {
                    console.error(`File ${fileId} not found when deleting, skipping...`);

                    return null;
                }

                if (file.refcount && file.refcount > 0 && !args.force) {
                    console.error(`File ${fileId} has refcount ${file.refcount} > 0, skipping...`);

                    return null;
                }

                const { page: grants } = await ctx.db.chatFileAccess.findMany({ where: { fileId } });

                await Promise.all(grants.map((grant) => ctx.db.delete(grant._id)));
                await ctx.db.delete(fileId);

                return fileId;
            }),
        );

        return deletedFileIds.filter((fileId) => fileId !== null);
    });

export const markExtractionProcessing = internalMutation
    .input({
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await ctx.db.patch(args.fileId, { extractionStatus: "processing" });

        return null;
    });

export const saveExtractedText = internalMutation
    .input({
        extractedText: v.string(),
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await patchRow(ctx.db, file, {
            extractedText: args.extractedText,
            extractionError: undefined,
            extractionStatus: "completed",
        });

        return null;
    });

export const markExtractionFailed = internalMutation
    .input({
        error: v.string(),
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await ctx.db.patch(args.fileId, {
            extractionError: args.error,
            extractionStatus: "failed",
        });

        return null;
    });

export const markNsfwChecking = internalMutation
    .input({
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await ctx.db.patch(args.fileId, { nsfwStatus: "checking" });

        return null;
    });

export const saveNsfwResult = internalMutation
    .input({
        fileId: v.id("chatFiles"),
        isNsfw: v.boolean(),
        scores: v.any(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        // `v.any()` arguments can arrive undefined, which a patch refuses.
        await ctx.db.patch(args.fileId, {
            ...withoutUndefined({ nsfwScores: args.scores }),
            nsfwStatus: args.isNsfw ? "blocked" : "safe",
        });

        return null;
    });

export const markNsfwFailed = internalMutation
    .input({
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await ctx.db.patch(args.fileId, { nsfwStatus: "failed" });

        return null;
    });

export const markExtractionUnsupported = internalMutation
    .input({
        fileId: v.id("chatFiles"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        if (!file) {
            return null;
        }

        await ctx.db.patch(args.fileId, { extractionStatus: "unsupported" });

        return null;
    });
