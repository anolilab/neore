/**
 * The internal functions behind the device upload route (`acp/upload-http.ts`) and the ingest's media events
 * (`acp/http.ts`): the signature check on the owner's shard, and the finalize that turns a staged upload into a
 * stored file.
 */
import { v } from "lunorash/server";

import { internalAction, internalQuery } from "../_generated/server";
import { nextHostSeq } from "../chat/streaming/persistent/host";
import { finalizeStagedUploadFile } from "../lib/chat-upload";
import { storageLogger } from "../lib/logger";
import { MAX_LENGTH } from "../lib/validators";
import { HOST_MEDIA_MIME_TYPES } from "./lib/constants";
import { verifyDeviceRequest } from "./lib/verify-device";

/** Who owns the device whose signed `upload` request this is, or null. The action never sees the secret. */
export const verifyHostUpload = internalQuery
    .input({ deviceId: v.string().max(MAX_LENGTH.id), now: v.number(), payload: v.string().max(MAX_LENGTH.document), signature: v.string().max(128) })
    .output(v.union(v.null(), v.object({ userId: v.string() })))
    .query(async ({ args, ctx }) => {
        const verified = await verifyDeviceRequest(ctx, { ...args, domain: "upload" });

        return verified ? { userId: verified.userId } : null;
    });

/** The `seq` the stream of host turn `turnId` expects next, or null when `userId` has no such stream (a turn's first post). */
export const hostStreamNext = internalQuery
    .input({ turnId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), v.number()))
    .query(async ({ args, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: args.turnId } });

        return stream?.userId === args.userId ? await nextHostSeq(ctx, stream._id) : null;
    });

/**
 * Turns `userId`'s staged upload into a stored chat file, the same finalize a browser attachment takes
 * (`takeStagedUpload`: the real size, the allowlist and the leading bytes are checked, the staging object is
 * deleted). `userId` is the device's verified owner, never anything the device sent, so another user's upload id
 * answers like a missing one. `null` for any failure: the caller shows the file as unavailable and the post goes on.
 */
export const finalizeHostUpload = internalAction
    .input({ filename: v.string().max(MAX_LENGTH.short), uploadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), v.object({ fileId: v.string(), mediaType: v.string(), storageKey: v.string() })))
    .action(async ({ args, ctx }) => {
        try {
            const { fileId, mediaType, storageId } = await finalizeStagedUploadFile(ctx, args.userId, { filename: args.filename, uploadId: args.uploadId });

            // Only what a host may attach: a type the device route allows, whatever the staged object said.
            return HOST_MEDIA_MIME_TYPES.includes(mediaType) ? { fileId: fileId as string, mediaType, storageKey: storageId } : null;
        } catch (error) {
            // The file name is the agent's and stays out of the log.
            storageLogger.warn("A host's uploaded file could not be finalized", error);

            return null;
        }
    });
