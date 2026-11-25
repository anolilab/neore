/**
 * File operations for chat attachments.
 * Migrated from `@neore/backend-agent` component.
 *
 * NOTE: Table renamed from 'files' to 'chatFiles' to avoid conflict with vault/files table.
 */
import type { InferArgs } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx as MutationContext, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import { claimFence, releaseClaim } from "../lib/claim-once";
import { isThreadLocked } from "../lib/thread-lock";
import { FILE_ATTACH_SCOPE, FILE_ATTACH_TTL_MS } from "./file-attach-claim";
import { checkThreadAccessBatchHandler } from "./threads";
import { isLockedWithoutProof } from "./thread-passcode";
import { paginatedDocsOf } from "../lib/output-validators";
import { MAX_LENGTH, paginationOptionsValidator } from "../lib/validators";
import { patchRow, withoutUndefined } from "../lib/patch";
import { systemDb } from "../lib/rls/scope";
import { isUniqueChatFileKey, isUniqueChatFileKeyFor } from "../lib/chat-file-key";
import { deleteStoredObjects } from "./client/object-deletes";
import { ownedStorageKeys } from "../lib/storage-ownership";
import { storedRow, storedRows } from "../lib/stored-row";

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
 * no `filename`, the row stored without one. A row a delete has marked
 * (`discardingAt`) is not handed out: it is going.
 */
const findChatFile = async (context: Pick<MutationContext, "db">, hash: string, filename: string | undefined) => {
    const { page } = await context.db.chatFiles.findMany({ limit: HASH_ROWS_LIMIT, where: filename ? { filename, hash } : { hash } });

    return page.find((row) => row.filename === filename && storedRow(row).discardingAt === undefined) ?? null;
};

/**
 * Hand an existing row out again: stamps `reusedAt` (a save rollback of the store that created it then keeps it), conditional on
 * no delete having marked it (`discardingAt`). `false` when one did: the caller stores its own row.
 */
const claimForReuse = async (context: MutationContext, fileId: Id<"chatFiles">, now: number): Promise<boolean> => {
    const { applied } = await context.db.patchIf("chatFiles", fileId, { patch: { lastTouchedAt: now, reusedAt: now }, where: { discardingAt: null } });

    return applied;
};

/**
 * How long a store has to write its row after its upload began (`useExistingFile` records the key as an upload under way). A
 * record still there past this is taken as a store that died, and the sweep deletes its object (`retryObjectDeletes`).
 */
export const STORE_INTENT_MS = 6 * 60 * 60 * 1000;

/** How long a delete under way has before the sweep takes it up again (`retryObjectDeletes`): a delete that failed or never returned. */
export const OBJECT_DELETE_RETRY_MS = 10 * 60 * 1000;

/** A record a store has claimed (`claimStoreIntent`): the sweep's `deleteAfter` range never reaches it. */
const CLAIMED_INTENT = Number.MAX_SAFE_INTEGER;

/**
 * Whether a row that is not being deleted names storage object `storageId`, read from the primary by the key itself
 * (`chatFiles.by_storageId`), never through a page of the bytes' hash: identical bytes stored under many names have many rows, and
 * a capped page of them can miss the one naming the key. Only an old content-addressed key (`agent-files/<sha256>`, see
 * `lib/chat-file-key.ts`) can be named by several rows, so only such a key is looked up. No new row names an old key, so once
 * none does, none will.
 */
const isStorageKeyNamed = async (context: Pick<QueryCtx, "db">, storageId: string): Promise<boolean> =>
    // `null` is the runtime "not discarding" filter. Codegen 443 types an optional column as absent in `where`,
    // which rejects `null` (upstream gap, see docs/agents/lunora-upstream.md); the cast keeps the runtime value.
    (await context.db.chatFiles.findFirst({ consistency: "primary", where: { discardingAt: null as unknown as undefined, storageId } })) !== null;

/** The record of `storageId` as an object to delete (`chatFileObjectDeletes`), read from the primary. */
const objectDeleteFor = async (context: Pick<QueryCtx, "db">, storageId: string) =>
    await context.db.chatFileObjectDeletes.findFirst({ consistency: "primary", where: { storageId } });

/**
 * Take the upload record of `storageId` for the row about to name it: one conditional write, so the sweep (which claims a due
 * record the same way) and this store cannot both have it. `false` when the record is gone, due or claimed: the sweep is (or
 * will be) deleting the object, so no row may name it.
 */
const claimStoreIntent = async (
    context: MutationContext,
    intent: { _id: Id<"chatFileObjectDeletes">; deleteAfter: number; kind: "delete" | "store" },
): Promise<boolean> => {
    if (intent.kind !== "store" || intent.deleteAfter <= context.now) {
        return false;
    }

    const { applied } = await context.db.patchIf("chatFileObjectDeletes", intent._id, {
        patch: { deleteAfter: CLAIMED_INTENT },
        where: { deleteAfter: intent.deleteAfter, kind: "store" },
    });

    return applied;
};

/**
 * Give back an upload record {@link claimStoreIntent} took, when the row that was to name its key was not written: the claim is a
 * `.global()` write that stays whatever the mutation does next, and a claimed record is one the sweep never takes, so the object
 * would be kept with nothing to delete it. The record gets its due time back, and the sweep deletes the object once it passes.
 * A failed insert that landed after all leaves a row naming the key: then the record is done instead, and the object is kept.
 */
const releaseStoreIntent = async (
    context: MutationContext,
    intent: { _id: Id<"chatFileObjectDeletes">; deleteAfter: number },
    storageId: string,
): Promise<void> => {
    try {
        if ((await context.db.chatFiles.findFirst({ consistency: "primary", where: { storageId } })) === null) {
            await context.db.patchIf("chatFileObjectDeletes", intent._id, {
                patch: { deleteAfter: intent.deleteAfter },
                where: { deleteAfter: CLAIMED_INTENT, kind: "store" },
            });
        } else {
            await context.db.delete("chatFileObjectDeletes", intent._id);
        }
    } catch (error) {
        console.error(`Failed to give back the upload record of ${storageId}; the object stays until it is deleted by hand:`, error);
    }
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
        const thread: { userId?: string } | null = await ctx.db.get("threads", args.threadId as Id<"threads">).catch(() => null);

        await grantFileAccess(ctx, args.fileId, thread?.userId);

        return null;
    });

export const addFile = internalMutation
    .input(addFileFields)
    .output(
        v.object({
            /** This call inserted the row; `false` when a racing store for the same bytes got there first. */
            created: v.boolean(),
            /**
             * This store's own upload, no longer needed because a racing store's row was reused: its delete is recorded, and the
             * caller runs it (`deleteStoredObjects`). `null` when the upload is the row's.
             */
            discardedUpload: v.union(v.id("chatFileObjectDeletes"), v.null()),
            fileId: v.id("chatFiles"), // RENAMED: files -> chatFiles
            storageId: v.string(),
        }),
    )
    .mutation(async ({ args, ctx }) => await addFileHandler(ctx, args));

/**
 * The export's view of a file (`chatFileMetadata`), written only if it is missing. The file row and this row are two writes, so a store
 * whose second write did not land leaves a file the export cannot see; the next store of the same bytes finds the row and completes this.
 */
export const ensureChatFileMetadata = async (
    context: MutationContext,
    file: { _creationTime: number; _id: Id<"chatFiles">; filename?: string; hash: string; mediaType: string },
): Promise<number> => {
    // Primary: a lagging replica that misses the row writes a second one (the export lists a file once, but the row is waste).
    const { page } = await context.db.chatFileMetadata.findMany({ consistency: "primary", where: { fileId: file._id } });

    if (page.length > 0) {
        // The bytes of the row read, so a caller that meters its reads counts them too.
        return new TextEncoder().encode(JSON.stringify(page)).byteLength;
    }

    // The file's own creation time, not the repair's: the export dates a file by it.
    await context.db.insert("chatFileMetadata", {
        createdAt: file._creationTime,
        fileId: file._id,
        filename: file.filename,
        hash: file.hash,
        mediaType: file.mediaType,
    });

    return 0;
};

export async function addFileHandler(context: MutationContext, args: InferArgs<typeof addFileFields>) {
    // A per-upload key must come with the record `useExistingFile` wrote before the upload: the record is what deletes the object
    // when the store dies, so a row may name the key only once it took that record.
    const unique = isUniqueChatFileKey(args.storageId);
    const intent = unique ? await objectDeleteFor(context, args.storageId) : null;

    if (unique && (intent === null || intent.kind !== "store" || intent.deleteAfter === CLAIMED_INTENT)) {
        throw new LunoraError("CONFLICT", "The upload's record is gone; store the file again.");
    }

    // Use compound index when filename is provided, otherwise use hash index
    const existingFile = await findChatFile(context, args.hash, args.filename);

    // A store that raced another for the same bytes: the row is shared, and only the messages that save it count
    // it (`changeRefcount`), as for a new row and for `useExistingFile`. Counting it here too kept it forever.
    // A row a delete marked first is not reused: this store writes its own.
    if (existingFile && (await claimForReuse(context, existingFile._id, Date.now()))) {
        await ensureChatFileMetadata(context, storedRow(existingFile));
        await grantFileAccess(context, existingFile._id, args.userId);

        // This store's own upload is not needed: its record becomes a delete due now, which the caller runs.
        const discard =
            intent === null
                ? null
                : await context.db.patchIf("chatFileObjectDeletes", intent._id, {
                      patch: { deleteAfter: context.now + OBJECT_DELETE_RETRY_MS, kind: "delete" },
                      where: { deleteAfter: intent.deleteAfter, kind: "store" },
                  });
        const discarded = discard?.applied === true;

        return {
            created: false,
            discardedUpload: discarded && intent ? intent._id : null,
            fileId: existingFile._id,
            storageId: existingFile.storageId,
        };
    }

    if (intent !== null && !(await claimStoreIntent(context, intent))) {
        throw new LunoraError("CONFLICT", "The upload took too long; store the file again.");
    }

    let insertedId: string;

    try {
        insertedId = await context.db.insert("chatFiles", {
            extractionStatus: "pending",
            filename: args.filename,
            hash: args.hash,
            lastTouchedAt: Date.now(),
            mediaType: args.mediaType,
            // We start out with it unused - when it's saved in a message we increment.
            refcount: 0,
            storageId: args.storageId,
        });
    } catch (error) {
        if (intent !== null) {
            await releaseStoreIntent(context, intent, args.storageId);
        }

        throw error;
    }

    const fileId = insertedId as Id<"chatFiles">;

    // The export's view of the file, written with it (`chatFileMetadata`): the export reads this, not the row that holds the text.
    await context.db.insert("chatFileMetadata", {
        createdAt: Date.now(),
        fileId,
        filename: args.filename,
        hash: args.hash,
        mediaType: args.mediaType,
    });

    await grantFileAccess(context, fileId, args.userId);

    // The row names the key now: its upload record is done (one whose delete failed stays claimed, which the sweep never takes).
    if (intent !== null) {
        await context.db.delete("chatFileObjectDeletes", intent._id);
    }

    return {
        created: true,
        discardedUpload: null,
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

/** Messages read per page by the unindexed-chat scan. */
const SCAN_PAGE = 100;

/**
 * True when `threadId` has a message carrying `fileId`. The fallback for a chat whose links are not indexed
 * yet (`filesIndexedAt` unset): exact, it reads pages until the file is found or the chat ends. Past RLS on
 * purpose: a decision that is never returned, and the caller's own locked chat.
 */
const threadHoldsFileByScan = async (context: Pick<QueryCtx, "db">, threadId: Id<"threads">, fileId: Id<"chatFiles">): Promise<boolean> => {
    const db = systemDb(context);
    let cursor: string | null = null;

    for (;;) {
        const page = await db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .paginate({ cursor, numItems: SCAN_PAGE });

        if (page.page.some((message) => message.fileIds?.includes(fileId))) {
            return true;
        }

        if (page.isDone) {
            return false;
        }

        cursor = page.continueCursor;
    }
};

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
 * A chat whose links are not indexed yet (`filesIndexedAt` unset, `agent/file-link-backfill.ts`)
 * is checked by its messages, so an attachment written before the links existed stays gated.
 *
 * Cost: one indexed read when the user has no locked chat; otherwise one
 * passcode-indexed read plus one point lookup per locked chat. An indexed chat
 * reads no message; an unindexed one reads its messages until the file is found.
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

    for (const { filesIndexedAt, threadId: lockedId } of passcodes) {
        // The chat the request names is opened by its own valid proof; any other locked chat is not.
        if (lockedId === threadId && !(await isLockedWithoutProof(context, lockedId, unlockProof))) {
            continue;
        }

        const thread = await context.db.get("threads", lockedId);

        if (!thread || !isThreadLocked(thread)) {
            continue;
        }

        if (await chatHoldsFile(context, lockedId, fileId)) {
            return true;
        }

        if (filesIndexedAt === undefined && (await threadHoldsFileByScan(context, lockedId, fileId))) {
            return true;
        }
    }

    return false;
};

/**
 * The `fileIds` that are gated for `userId` (`fileGatedByLockedChat`), checked on the shard it runs on.
 *
 * Run on the CALLER's shard, never only the thread owner's. A collaborator's own locked chat has its passcode rows and
 * file links on the collaborator's shard, so the owner's shard cannot see that the file is gated: a file from the
 * collaborator's locked chat would attach to the owner's shared chat with no passcode. `/chat/start` and `/chat/edit`
 * call this on the caller's shard before they switch to the thread's shard.
 */
export const gatedFileIdsOnCallerShard = async (
    context: Pick<QueryCtx, "db">,
    { fileIds, threadId, unlockProof, userId }: { fileIds: Id<"chatFiles">[]; threadId?: Id<"threads">; unlockProof?: string; userId: string },
): Promise<Id<"chatFiles">[]> => {
    const gated: Id<"chatFiles">[] = [];

    // A repeated id is checked once: each check reads the caller's locked chats again.
    const distinctFileIds = [...new Set(fileIds)];

    for (const fileId of distinctFileIds) {
        if (await fileGatedByLockedChat(context, { fileId, threadId, unlockProof, userId })) {
            gated.push(fileId);
        }
    }

    return gated;
};

/**
 * Checks the attach's files on the caller's shard AND takes its in-flight claim (`agent/file-attach-claim.ts`), in one
 * transaction: the lock cannot commit between the check and the claim. Returns the gated ids (no claim taken when any is
 * gated) and, when the files may attach, the claim's `claimedAt`, which `endFileAttach` releases.
 */
export const beginFileAttach = internalMutation
    .input({
        fileIds: v.array(v.id("chatFiles")),
        requestId: v.string().max(MAX_LENGTH.id),
        threadId: v.optional(v.id("threads")),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(v.object({ claimedAt: v.optional(v.number()), gated: v.array(v.id("chatFiles")) }))
    .mutation(async ({ args, ctx }) => {
        const gated = await gatedFileIdsOnCallerShard(ctx, args);

        if (gated.length > 0 || args.fileIds.length === 0) {
            return { gated };
        }

        const claimedAt = await claimFence(ctx, FILE_ATTACH_SCOPE, `${args.userId}:${args.requestId}`, {
            ttlMs: FILE_ATTACH_TTL_MS,
            userId: args.userId,
        });

        // A request id is unique per attach, so a held key is not expected. Throwing refuses the attach (fail closed).
        if (claimedAt === null) {
            throw new LunoraError("CONFLICT", "The file attach is already in progress.");
        }

        return { claimedAt, gated };
    });

/** Releases the claim `beginFileAttach` took, once the attach's message is saved. A claim that is no longer the caller's is left alone. */
export const endFileAttach = internalMutation
    .input({ claimedAt: v.number(), requestId: v.string().max(MAX_LENGTH.id), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await releaseClaim(ctx, FILE_ATTACH_SCOPE, `${args.userId}:${args.requestId}`, args.claimedAt);

        return null;
    });

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
        const row = storedRow(await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } }));
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
        /**
         * The per-upload key (`lib/chat-file-key.ts#newChatFileKey`) the caller uploads to when no row is found. It is recorded as
         * an upload under way (`chatFileObjectDeletes`, due after {@link STORE_INTENT_MS}) before the upload starts, so a store that
         * dies before its row leaves a record the sweep deletes the object by.
         */
        uploadKey: v.optional(v.string().max(MAX_LENGTH.short)),
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
        if (args.uploadKey !== undefined && !isUniqueChatFileKeyFor(args.uploadKey, args.hash)) {
            throw new LunoraError("BAD_REQUEST", "An upload key names its own bytes and one upload.");
        }

        // Use compound index when filename is provided, otherwise use hash index
        const file = await findChatFile(ctx, args.hash, args.filename);

        // None, or one a delete marked meanwhile (it is going): the caller stores the bytes as new, under its own key.
        if (!file || !(await claimForReuse(ctx, file._id, ctx.now))) {
            if (args.uploadKey !== undefined) {
                await ctx.db.insert("chatFileObjectDeletes", { deleteAfter: ctx.now + STORE_INTENT_MS, kind: "store", storageId: args.uploadKey });
            }

            return null;
        }

        await ensureChatFileMetadata(ctx, storedRow(file));
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

        const file = storedRow(await context.db.chatFiles.findFirst({ where: { _id: fileId } }));

        if (file && file.refcount > 0) {
            await patchRow(context.db, "chatFiles", file, refcountChange(file, file.refcount - 1));
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

        const file = storedRow(await context.db.chatFiles.findFirst({ where: { _id: fileId } }));
        // Conditional on no delete having marked the row: a reference that lands after the mark would name a row about to go.
        const counted =
            file === null ? null : await context.db.patchIf("chatFiles", fileId, { patch: { refcount: file.refcount + 1 }, where: { discardingAt: null } });

        if (!file || !counted?.applied) {
            throw new Error(`File ${fileId} not found when incrementing refcount`);
        }

        if (file.unreferencedSince !== undefined) {
            await patchRow(context.db, "chatFiles", { ...file, refcount: file.refcount + 1 }, { unreferencedSince: undefined });
        }
    }
};

/** Link rows one `deleteChatFileLinksForThread` call deletes. */
export const LINK_BATCH = 100;

/**
 * Records that the thread's owner holds these files in `threadId` (`chatFileThreads`).
 * Idempotent. A thread with no owner cannot be locked, so it needs no link.
 */
export const linkChatFiles = async (context: MutationContext, threadId: Id<"threads">, fileIds: Id<"chatFiles">[]): Promise<void> => {
    if (fileIds.length === 0) {
        return;
    }

    // The owner, read past RLS: a collaborator's write must link under the owner, whatever the caller may read.
    const thread = await systemDb(context).get("threads", threadId);

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

/**
 * Drops one batch of a thread's `chatFileThreads` links when the thread is permanently deleted.
 * Returns true while links remain: the paged delete (`agent/threads.ts`) re-runs its final page until it is false.
 */
export const deleteChatFileLinksForThread = async (context: MutationContext, threadId: Id<"threads">): Promise<boolean> => {
    const rows = await context.db
        .query("chatFileThreads")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(LINK_BATCH);

    await Promise.all(rows.map((row) => context.db.delete("chatFileThreads", row._id)));

    return rows.length === LINK_BATCH;
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

    await context.db.patch("chatFiles", args.fileId, {
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

        return { continueCursor: page.continueCursor, isDone: page.isDone, page: storedRows(page.page) };
    });

/**
 * Delete a `chatFiles` row with its export view (`chatFileMetadata`), in the caller's mutation. The metadata goes first, then the
 * file row. A failed row delete leaves the file to the next sweep, and the file is hidden from exports only until then. The other
 * order fails for good: a metadata delete that failed after the row went would leave an orphaned row, which no sweep finds again,
 * and exports would list the file. Primary reads: a replica that lags could miss a row, and the export would list a deleted file.
 */
const deleteFileRowWithMetadata = async (context: MutationContext, fileId: Id<"chatFiles">): Promise<void> => {
    const { page: metadata } = await context.db.chatFileMetadata.findMany({ consistency: "primary", where: { fileId } });

    await Promise.all(metadata.map((row) => context.db.delete("chatFileMetadata", row._id)));
    await context.db.delete("chatFiles", fileId);

    // A repair or a reuse that wrote the metadata between the two deletes left a row for a file that is now gone: clear it.
    const { page: late } = await context.db.chatFileMetadata.findMany({ consistency: "primary", where: { fileId } });

    await Promise.all(late.map((row) => context.db.delete("chatFileMetadata", row._id)));
};

/**
 * Delete one `chatFiles` row with its grants and export view, when the conditional mark matches (`where`, plus no other delete's
 * mark): the mark is the one write that decides, so a reuse or a new reference (both conditional on no mark) lands before it and
 * the row stays, or after it and finds the row going. `null` when the row stays or is gone.
 *
 * The row's object is recorded for deletion (`chatFileObjectDeletes`) right after the mark, before the row's other rows go, so a
 * mutation that stops part way leaves the record, and the sweep deletes the object. A per-upload key is named only by this row (a
 * store of the same bytes writes a key of its own), so it is always recorded; an old shared key only when no other row names it.
 */
const discardFileRow = async (
    context: MutationContext,
    file: { _id: Id<"chatFiles">; discardingAt?: number; hash: string; storageId: string },
    where: Record<string, unknown>,
): Promise<{ deleteId: Id<"chatFileObjectDeletes"> | null } | null> => {
    const { now } = context;
    const { applied } = await context.db.patchIf("chatFiles", file._id, {
        patch: { discardingAt: now },
        where: { discardingAt: file.discardingAt ?? null, ...where },
    });

    if (!applied) {
        return null;
    }

    const deleteId =
        isUniqueChatFileKey(file.storageId) || !(await isStorageKeyNamed(context, file.storageId))
            ? ((await context.db.insert("chatFileObjectDeletes", {
                  deleteAfter: now + OBJECT_DELETE_RETRY_MS,
                  kind: "delete",
                  storageId: file.storageId,
              })) as Id<"chatFileObjectDeletes">)
            : null;

    const { page: grants } = await context.db.chatFileAccess.findMany({ where: { fileId: file._id } });

    for (const grant of grants) {
        await context.db.delete("chatFileAccess", grant._id);
    }

    await deleteFileRowWithMetadata(context, file._id);

    return { deleteId };
};

/**
 * The unused-file sweep's delete (`crons.ts#deleteUnusedFiles`). A row is taken only while nothing touched it since the sweep read it
 * (`lastTouchedAt`, which every reuse moves) and no message counts it, unless `force`. Its storage object is deleted after the
 * mutation, through the record {@link discardFileRow} wrote.
 */
export const deleteFiles = internalMutation
    .input({
        fileIds: v.array(v.id("chatFiles")), // RENAMED: files -> chatFiles
        force: v.optional(v.boolean()),
    })
    .output(v.array(v.id("chatFiles")))
    .mutation(async ({ args, ctx }) => {
        const deleted: Id<"chatFiles">[] = [];
        const deleteIds: Id<"chatFileObjectDeletes">[] = [];

        const fileIds = new Set(args.fileIds);

        // One file at a time: a conditional write per file, and the D1 statements of a batch stay countable.
        for (const fileId of fileIds) {
            const file = storedRow(await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

            if (!file) {
                console.error(`File ${fileId} not found when deleting, skipping...`);
                continue;
            }

            if (file.refcount > 0 && !args.force) {
                console.error(`File ${fileId} has refcount ${file.refcount} > 0, skipping...`);
                continue;
            }

            const outcome = await discardFileRow(ctx, file, args.force ? {} : { lastTouchedAt: file.lastTouchedAt, refcount: 0 });

            if (!outcome) {
                continue;
            }

            deleted.push(fileId);

            if (outcome.deleteId) {
                deleteIds.push(outcome.deleteId);
            }
        }

        if (deleteIds.length > 0) {
            await ctx.scheduler.runAfter(0, internal.agent.files.deleteStoredObjectsJob, { deleteIds });
        }

        return deleted;
    });

/**
 * Take back files a save stored and then failed to save (`agent/client/tool-approval.ts`). A row is deleted, with its grants
 * and its export view (`chatFileMetadata`), only while it is still exactly the one that store created: no message counts it
 * (`refcount`) and no other store reused it (`reusedAt`), whose own message would count it only once it saves. That check is
 * the conditional mark (`discardFileRow`), so a reuse lands before it (the row stays, every grant with it) or after it (it
 * finds the row going and stores its own). Returns the object deletes it recorded; the caller runs them
 * (`deleteStoredObjects` (`client/object-deletes.ts`)).
 */
export const discardUnsavedFiles = internalMutation
    .input({ fileIds: v.array(v.id("chatFiles")) })
    .output(v.array(v.id("chatFileObjectDeletes")))
    .mutation(async ({ args, ctx }) => {
        const deleteIds: Id<"chatFileObjectDeletes">[] = [];

        const fileIds = new Set(args.fileIds);

        // One file at a time: each costs a handful of D1 statements, and a step stores only a few.
        for (const fileId of fileIds) {
            const file = storedRow(await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

            if (!file || file.refcount > 0 || file.reusedAt !== undefined) {
                continue;
            }

            const outcome = await discardFileRow(ctx, file, { refcount: 0, reusedAt: null });

            if (outcome?.deleteId) {
                deleteIds.push(outcome.deleteId);
            }
        }

        return deleteIds;
    });

/** The keys of recorded object deletes; a record already done is left out. */
export const objectDeleteKeys = internalQuery
    .input({ deleteIds: v.array(v.id("chatFileObjectDeletes")) })
    .output(v.array(v.object({ deleteId: v.id("chatFileObjectDeletes"), storageId: v.string() })))
    .query(async ({ args, ctx }) => {
        const records = await Promise.all(
            args.deleteIds.map(async (deleteId) => await ctx.db.chatFileObjectDeletes.findFirst({ consistency: "primary", where: { _id: deleteId } })),
        );

        return records
            .filter((record) => record !== null)
            .map((record) => {
                return { deleteId: record._id as Id<"chatFileObjectDeletes">, storageId: record.storageId };
            });
    });

/** End a recorded object delete once the object delete returned. */
export const endObjectDelete = internalMutation
    .input({ deleteId: v.id("chatFileObjectDeletes") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const record = await ctx.db.chatFileObjectDeletes.findFirst({ consistency: "primary", where: { _id: args.deleteId } });

        if (record) {
            await ctx.db.delete("chatFileObjectDeletes", record._id);
        }

        return null;
    });

/** Recorded deletes taken up per {@link retryObjectDeletes} call: a read and one conditional write each. */
export const OBJECT_DELETE_RETRY_PAGE = 10;

/**
 * Object deletes that are due and not done: a delete that failed or whose action died, and the upload record of a store that never
 * wrote its row. The record is the one trace of a key no row names, so it is never dropped unanswered: each is claimed again (its
 * `deleteAfter` moved on, conditional on the value read, so a store claiming its upload record at the same time loses or wins
 * whole) and deleted again through `deleteStoredObjects` (`client/object-deletes.ts`). A full page takes up the next one at once.
 */
export const retryObjectDeletes = internalMutation
    .input({})
    .output(v.array(v.id("chatFileObjectDeletes")))
    .mutation(async ({ ctx }) => {
        const { page } = await ctx.db.chatFileObjectDeletes.findMany({
            consistency: "primary",
            limit: OBJECT_DELETE_RETRY_PAGE,
            where: { deleteAfter: { lt: ctx.now } },
        });
        const deleteIds: Id<"chatFileObjectDeletes">[] = [];

        for (const record of page) {
            // A due upload record becomes a delete: its store, back late, finds it no longer its own (`claimStoreIntent`).
            const { applied } = await ctx.db.patchIf("chatFileObjectDeletes", record._id, {
                patch: { deleteAfter: ctx.now + OBJECT_DELETE_RETRY_MS, kind: "delete" },
                where: { deleteAfter: record.deleteAfter, kind: record.kind },
            });

            if (applied) {
                deleteIds.push(record._id as Id<"chatFileObjectDeletes">);
            }
        }

        if (deleteIds.length > 0) {
            await ctx.scheduler.runAfter(0, internal.agent.files.deleteStoredObjectsJob, { deleteIds });
        }

        if (page.length === OBJECT_DELETE_RETRY_PAGE) {
            await ctx.scheduler.runAfter(0, internal.agent.files.retryObjectDeletes, {});
        }

        return deleteIds;
    });

/** `deleteStoredObjects` (`client/object-deletes.ts`) for a mutation's deletes, scheduled after it committed (`deleteFiles`, `retryObjectDeletes`). */
export const deleteStoredObjectsJob = internalAction
    .input({ deleteIds: v.array(v.id("chatFileObjectDeletes")) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await deleteStoredObjects(ctx, args.deleteIds);

        return null;
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

        await ctx.db.patch("chatFiles", args.fileId, { extractionStatus: "processing" });

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

        await patchRow(ctx.db, "chatFiles", file, {
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

        await ctx.db.patch("chatFiles", args.fileId, {
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

        await ctx.db.patch("chatFiles", args.fileId, { nsfwStatus: "checking" });

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
        await ctx.db.patch("chatFiles", args.fileId, {
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

        await ctx.db.patch("chatFiles", args.fileId, { nsfwStatus: "failed" });

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

        await ctx.db.patch("chatFiles", args.fileId, { extractionStatus: "unsupported" });

        return null;
    });
