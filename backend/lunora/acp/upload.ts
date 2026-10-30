/**
 * The internal functions behind the device upload route (`acp/upload-http.ts`) and the ingest's media events
 * (`acp/http.ts`): the signature check on the owner's shard, and the finalize that turns a staged upload into a
 * stored file.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internalAction, internalQuery } from "../_generated/server";
import { nextHostSeq } from "../chat/streaming/persistent/host";
import { internal } from "../_generated/internal";
import { cacheKeyFor } from "../lib/action-cache";
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

/** The name a finalize's result is remembered under, per owner and upload. */
const FINALIZE_MEMO = "host-upload-finalize";

/** Longer than a staging object lives (`STAGING_TTL_MS`) and than a host keeps resending a post. */
const FINALIZE_MEMO_TTL_MS = 2 * 60 * 60 * 1000;

const vFinalized = v.object({ fileId: v.string(), mediaType: v.string(), storageKey: v.string() });

/**
 * Turns `userId`'s staged upload into a stored chat file, the same finalize a browser attachment takes
 * (`takeStagedUpload`: the real size, the allowlist and the leading bytes are checked, the staging object is
 * deleted). `userId` is the device's verified owner, never anything the device sent, so another user's upload id
 * answers like a missing one. `null` for any failure: the caller shows the file as unavailable and the post goes on.
 */
export const finalizeHostUpload = internalAction
    .input({ filename: v.string().max(MAX_LENGTH.short), uploadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.null(), vFinalized))
    .action(async ({ args, ctx }) => {
        // Finalizing deletes the staging object, and the host resends a post whose answer it never saw (a 429, a 5xx, a
        // lost response): the second finalize would find nothing. So the result is remembered by owner and upload, and
        // a resend reuses it, with one file row and one grant.
        const key = await cacheKeyFor(FINALIZE_MEMO, `${args.userId}:${args.uploadId}`);
        const remembered = async () => {
            const hit = await ctx.runQuery(internal.lib.action_cache.get, { key, now: Date.now() });

            return hit.kind === "hit" ? (hit.value as Infer<typeof vFinalized>) : null;
        };
        const earlier = await remembered();

        if (earlier !== null) {
            return earlier;
        }

        try {
            const { fileId, mediaType, storageId } = await finalizeStagedUploadFile(ctx, args.userId, { filename: args.filename, uploadId: args.uploadId });

            // Only what a host may attach: a type the device route allows, whatever the staged object said.
            if (!HOST_MEDIA_MIME_TYPES.includes(mediaType)) {
                return null;
            }

            const finalized = { fileId: fileId as string, mediaType, storageKey: storageId };

            // A memo that could not be written costs only a resend its file; the finalize itself stands.
            await ctx
                .runMutation(internal.lib.action_cache.put, { key, name: FINALIZE_MEMO, ttl: FINALIZE_MEMO_TTL_MS, value: finalized })
                .catch((error: unknown) => {
                    storageLogger.warn("A host's finalized upload could not be remembered", error);
                });

            return finalized;
        } catch (error) {
            // Two posts at once: the other one finalized first, and its result is there now.
            const concurrent = await remembered();

            if (concurrent !== null) {
                return concurrent;
            }

            // The file name is the agent's and stays out of the log.
            storageLogger.warn("A host's uploaded file could not be finalized", error);

            return null;
        }
    });
