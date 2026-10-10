/**
 * Chat attachment uploads — the bytes go straight from the browser to storage.
 *
 * 1. The browser sends the file over TUS to the upload route
 *    (`lib/upload-route.ts`), which stores it under a staging key in the
 *    caller's own prefix (`uploads/<userId>/<uploadId>`,
 *    `lib/chat-upload-staging.ts`) and refuses a declared type off the
 *    allowlist or a declared size over its kind's limit.
 * 2. {@link finalizeChatUpload} reads what actually arrived, checks its real
 *    size, type and leading bytes, and stores it content-addressed through
 *    `storeFile` (dedupe into `chatFiles`, a `chatFileAccess` grant for the
 *    caller), then deletes the staging object. It returns the `chatFiles` id
 *    that `/chat/start`'s `fileIds` and extraction already take.
 *
 * The bytes never ride in an RPC body: Lunora caps that at 1 MiB, which is what
 * kept attachments under ~750 KB before.
 *
 * A staging object nobody finalizes is deleted by a reap the upload route
 * schedules when the upload is created and, as a backstop, by the shard
 * housekeeping sweep ({@link sweepStagedChatUploads}). The logic lives in
 * `lib/chat-upload.ts`.
 */
import { v } from "lunorash/server";

import { internal } from "./_generated/internal";
import { internalAction, internalMutation } from "./_generated/server";
import { finalizeStagedUpload, purgeStagedUploads } from "./lib/chat-upload";
import { authAction, authQuery, rateLimit } from "./lib/crpc";
import { currentUserShard } from "./lib/shard-context";
import { MAX_LENGTH } from "./lib/validators";

/**
 * Turn an uploaded staging object into a chat file the caller may attach.
 *
 * The caller names only the `uploadId`; the key is rebuilt under the CALLER's
 * own staging prefix, so another user's upload is not addressable — it answers
 * exactly like a missing one.
 */
export const finalizeChatUpload = authAction
    .use(rateLimit("chat/attachmentUpload"))
    .input({
        filename: v.string().max(MAX_LENGTH.short),
        uploadId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ fileId: v.id("chatFiles"), url: v.string() }))
    .action(async ({ args, ctx }) => {
        const finalized = await finalizeStagedUpload(ctx, ctx.user.userId, args);

        // The file id only: the filename is user-chosen and stays out of the logs.
        ctx.log.event("file.finalize_chat_upload", { fileId: finalized.fileId });

        return finalized;
    });

/**
 * Where a just-uploaded attachment's text extraction stands, for the chip that
 * shows "reading document…" until it lands — a message sent earlier gets the
 * raw file instead of its text. `null` for a file the caller holds no
 * `chatFileAccess` grant for, exactly like one that does not exist; extracted
 * text itself is never returned.
 */
export const getChatFileExtraction = authQuery
    .input({ fileId: v.id("chatFiles") })
    .output(
        v.union(
            v.null(),
            v.object({
                status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"), v.literal("unsupported")),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const grant = await ctx.db.chatFileAccess.findFirst({ where: { fileId: args.fileId, userId: ctx.user.userId } });

        if (!grant) {
            return null;
        }

        const file = await ctx.db.chatFiles.findFirst({ where: { _id: args.fileId } });

        return file ? { status: file.extractionStatus ?? "pending" } : null;
    });

/**
 * Housekeeping backstop for the per-key reap: on a user's shard, schedule a
 * purge of that user's stale staging objects. A mutation, as every shard sweep
 * is (`lib/shard-housekeeping.ts`); the delete itself needs an action.
 */
export const sweepStagedChatUploads = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId) {
            await ctx.scheduler.runAfter(0, internal.file.purgeStagedChatUploads, { userId });
        }

        return null;
    });

/** Deletes `userId`'s staging objects and abandoned upload state older than the staging TTL. */
export const purgeStagedChatUploads = internalAction
    .input({ userId: v.string() })
    .output(v.object({ deleted: v.number() }))
    .action(async ({ args, ctx }) => {
        return { deleted: await purgeStagedUploads(ctx.storage, args.userId, Date.now()) };
    });
