/**
 * File operations for chat attachments.
 * Migrated from `@neore/backend-agent` component.
 *
 * NOTE: Table renamed from 'files' to 'chatFiles' to avoid conflict with vault/files table.
 */
import type { InferArgs } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx } from "../_generated/server";
import { isThreadLocked } from "../lib/thread-lock";
import { checkThreadAccessBatchHandler } from "./threads";
import { isLockedWithoutProof } from "./thread-passcode";
import { paginatedDocsOf } from "../lib/output-validators";
import { MAX_LENGTH, paginationOptionsValidator } from "../lib/validators";
import { patchRow, withoutUndefined } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
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

/** True when `threadId` holds `fileId` by a message write (`chatFileThreads`): one point lookup. */
const chatHoldsFile = async (context: Pick<QueryCtx, "db">, threadId: Id<"threads">, fileId: Id<"chatFiles">): Promise<boolean> =>
    (await context.db
        .query("chatFileThreads")
        .withIndex("by_fileId_threadId", (q) => q.eq("fileId", fileId).eq("threadId", threadId))
        .first()) !== null;

/**
 * True when `fileId` is GATED for this request: it sits on a locked chat of
 * `userId` that the request does not open. A file in a locked chat is that
 * chat's content, so a grant alone must not carry it into any other chat (a new
 * one, an unlocked one) nor out through a reader that returns its bytes, text or
 * URL. The request opens a locked chat only by naming it (`threadId`) WITH that
 * chat's valid proof. The caller's own passcode rows name their locked chats
 * (shard-local, owner-scoped); the chats a file sits in are the `chatFileThreads`
 * links the message writers record (`changeMessageFiles`).
 *
 * Cost: one indexed read when the user has no locked chat; otherwise one
 * passcode-indexed read plus one point lookup per locked chat. No message is read.
 */
export const fileGatedByLockedChat = async (
    context: Pick<QueryCtx, "db">,
    { fileId, threadId, unlockProof, userId }: { fileId: Id<"chatFiles">; threadId?: Id<"threads">; unlockProof?: string; userId: string },
): Promise<boolean> => {
    const passcodes = await context.db
        .query("threadPasscodes")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    // The common case: no locked chat, so the reactive read set is this one index range.
    if (passcodes.length === 0) {
        return false;
    }

    for (const { threadId: lockedId } of passcodes) {
        // The chat the request names is opened by its own valid proof; any other locked chat is not.
        if (lockedId === threadId && !(await isLockedWithoutProof(context, lockedId, unlockProof))) {
            continue;
        }

        const thread = await context.db.get(lockedId);

        if (thread && isThreadLocked(thread) && (await chatHoldsFile(context, lockedId, fileId))) {
            return true;
        }
    }

    return false;
};

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
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
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

        // A file read in a locked thread is that thread's content: refused before
        // the grant shortcut below, which would otherwise return it.
        if (args.threadId && (await isLockedWithoutProof(ctx, args.threadId, args.unlockProof))) {
            return null;
        }

        const grant = await ctx.db.chatFileAccess.findFirst({ where: { fileId: args.fileId, userId: args.userId } });

        if (grant) {
            // The grant proves the caller stored the bytes, not that they may read them here: a file
            // in another locked chat of theirs is that chat's content, whatever chat it is attached to.
            if (await fileGatedByLockedChat(ctx, { fileId: args.fileId, threadId: args.threadId, unlockProof: args.unlockProof, userId: args.userId })) {
                return null;
            }

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

export const UNTOUCHED_FILE_RETENTION_MS = 1000 * 60 * 60 * 24;

export const UNREFERENCED_FILE_GRACE_MS = 1000 * 60 * 60 * 24;

type RefcountedFile = { lastTouchedAt: number; refcount: number; unreferencedSince?: number };

const refcountChange = (file: RefcountedFile, refcount: number): { refcount: number; unreferencedSince?: number } => {
    if (refcount === 0) {
        return { refcount, unreferencedSince: Date.now() };
    }

    return file.unreferencedSince === undefined ? { refcount } : { refcount, unreferencedSince: undefined };
};

/**
 * A released file is kept for {@link UNREFERENCED_FILE_GRACE_MS} after its last reference went, so an undo that
 * restores the reference still finds it. A file never referenced only waits out the untouched retention.
 */
export const isUnusedFileDue = (file: RefcountedFile, now: number): boolean =>
    file.refcount === 0 &&
    file.lastTouchedAt < now - UNTOUCHED_FILE_RETENTION_MS &&
    (file.unreferencedSince === undefined || file.unreferencedSince < now - UNREFERENCED_FILE_GRACE_MS);

export const changeRefcount = async (context: MutationContext, previous: Id<"chatFiles">[], next: Id<"chatFiles">[]) => {
    const previousSet = new Set(previous);
    const nextSet = new Set(next);

    for (const fileId of previousSet) {
        if (nextSet.has(fileId)) {
            continue;
        }

        const file = await context.db.chatFiles.findFirst({ where: { _id: fileId } });

        if (file && file.refcount > 0) {
            await patchRow(context.db, file, refcountChange(file, file.refcount - 1));
        } else if (file) {
            // A release with no matching add (a write that counted differently) must not take the count below zero,
            // nor re-stamp `unreferencedSince` on a file that is already released.
            console.error(`File ${fileId} has no reference to release`);
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
            await patchRow(context.db, file, refcountChange(file, file.refcount + 1));
        } else {
            throw new Error(`File ${fileId} not found when incrementing refcount`);
        }
    }
};

/** Rows read per round when a thread's links are deleted. */
const LINK_BATCH = 100;

/**
 * Records that the thread's owner holds these files in `threadId` (`chatFileThreads`).
 * Idempotent. A thread with no owner cannot be locked, so it needs no link.
 */
const linkChatFiles = async (context: MutationContext, threadId: Id<"threads">, fileIds: Id<"chatFiles">[]): Promise<void> => {
    if (fileIds.length === 0) {
        return;
    }

    // The owner, read past RLS: a collaborator's write must link under the owner, whatever the caller may read.
    const thread = await systemDb(context).get(threadId);

    if (!thread?.userId) {
        return;
    }

    const unique = new Set(fileIds);

    for (const fileId of unique) {
        const existing = await context.db
            .query("chatFileThreads")
            .withIndex("by_fileId_threadId", (q) => q.eq("fileId", fileId).eq("threadId", threadId))
            .first();

        if (!existing) {
            await context.db.insert("chatFileThreads", { createdAt: Date.now(), fileId, threadId, userId: thread.userId });
        }
    }
};

/**
 * `changeRefcount` for a message's files, plus the links for the files it adds to
 * `threadId`. A link is never removed when a message drops a file: the thread may
 * still hold it through another message, and a stale link only over-gates.
 */
export const changeMessageFiles = async (
    context: MutationContext,
    threadId: Id<"threads">,
    previous: Id<"chatFiles">[],
    next: Id<"chatFiles">[],
): Promise<void> => {
    await changeRefcount(context, previous, next);

    const previousSet = new Set(previous);

    await linkChatFiles(
        context,
        threadId,
        next.filter((fileId) => !previousSet.has(fileId)),
    );
};

/** Drops a thread's `chatFileThreads` links when the thread is permanently deleted. */
export const deleteChatFileLinksForThread = async (context: MutationContext, threadId: Id<"threads">): Promise<void> => {
    const take = async () =>
        await context.db
            .query("chatFileThreads")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .take(LINK_BATCH);

    let rows = await take();

    while (rows.length > 0) {
        await Promise.all(rows.map((row) => context.db.delete(row._id)));

        rows = await take();
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
