/**
 * The job-time recheck of a media request's references (`generateImage`), run before the provider call. The job runs on the
 * thread owner's shard, so the caller's rows are read on the caller's shard and each referenced chat on its owner's shard, the
 * same two steps as the request (`chat/reference-gate.ts`). A lock or grant that changed after the request refuses the job here.
 *
 * Each chat that stays held also gets an attach claim on its owner's shard, which `enableThreadLock` refuses while it is held. So a
 * lock cannot commit between this check and the provider reading the reference. The claims are released once the job is done
 * (`releaseReferenceClaims`); a job that dies keeps them only until their TTL.
 */
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { LunoraError } from "lunorash/server";
import { callOnShard } from "../lib/cross-shard";
import { chatLogger } from "../lib/logger";
import { MAX_STORED_READ_BYTES, readStoredObject, type StorageReader } from "../lib/storage-read";
import { threadShardFor } from "../lib/thread-shard";

/** An attach claim taken on a referenced chat's owner shard, released by {@link releaseReferenceClaims}. */
export interface ReferenceClaim {
    claimedAt: number;
    shardKey: string;
    threadId: string;
}

/**
 * Whether every reference is still the caller's own row under its URL, and every chat it sits in is still held by the caller.
 * Each claim is pushed to `claims` as it is taken, so the caller releases them even when the check throws part-way.
 * Returns `null` when a reference is no longer held; otherwise the stored object of each reference, paired by position (`""` for a
 * document, whose content is inline).
 */
export const referencesStillHeld = async (
    context: Parameters<typeof threadShardFor>[0],
    {
        claims,
        referenceIds,
        referenceImages,
        requestedAt,
        requestId,
        userId,
    }: { claims: ReferenceClaim[]; referenceIds: string[]; referenceImages: string[]; requestedAt: number; requestId: string; userId: string },
): Promise<string[] | null> => {
    const rows = await callOnShard(
        internal.chat.reference_gate.gateReferenceRowsOnCallerShard,
        { referenceIds, referenceImages, userId },
        { shardKey: userId },
    );

    if (rows.refused) {
        return null;
    }

    for (const chatId of rows.chatIds) {
        const shardKey = await threadShardFor(context, userId, chatId);
        const { claimedAt, held } = await callOnShard(
            internal.chat.reference_gate.holdReferenceChatOnShard,
            { requestedAt, requestId, threadId: chatId, userId },
            { shardKey },
        );

        if (claimedAt !== undefined) {
            claims.push({ claimedAt, shardKey, threadId: chatId });
        }

        if (!held) {
            return null;
        }
    }

    // Renewed last, right before the provider call: a hold that lapsed while a later chat was checked is re-taken only if its chat is
    // still held, so a lock that committed in that gap refuses the job here instead of reaching the provider.
    for (const { claimedAt, shardKey, threadId } of claims) {
        const { held } = await callOnShard(
            internal.chat.reference_gate.renewReferenceChatOnShard,
            { claimedAt, requestedAt, requestId, threadId, userId },
            { shardKey },
        );

        if (!held) {
            return null;
        }
    }

    return rows.storageKeys;
};

const BASE64_CHUNK = 0x80_00;

const toBase64 = (bytes: ArrayBuffer): string => {
    const view = new Uint8Array(bytes);
    let binary = "";

    for (let offset = 0; offset < view.length; offset += BASE64_CHUNK) {
        binary += String.fromCodePoint(...view.subarray(offset, offset + BASE64_CHUNK));
    }

    return btoa(binary);
};

/**
 * The reference images as the provider should receive them, read after the holds are renewed. A file's bytes are read from storage
 * and sent inline as a data URI, so the provider never fetches a signed URL: a grant revoked after the recheck cannot reach it
 * through a URL it fetches later. A document's content is already inline and passes through. A stored object that is not an image is
 * refused, and so is one that is missing, so a failed read fails the job rather than sending the reference URL.
 */
export const referenceBytesForProvider = async (storage: StorageReader | undefined, referenceImages: string[], storageKeys: string[]): Promise<string[]> =>
    await Promise.all(
        referenceImages.map(async (url, index) => {
            const key = storageKeys[index];

            if (!key) {
                return url;
            }

            const { bytes, contentType } = await readStoredObject(storage, key, { maxBytes: MAX_STORED_READ_BYTES });

            if (!contentType?.startsWith("image/")) {
                throw new LunoraError("BAD_REQUEST", "A reference is not an image");
            }

            return `data:${contentType};base64,${toBase64(bytes)}`;
        }),
    );

/**
 * Releases the claims {@link referencesStillHeld} took, once the provider has its references. A release that fails is logged, not
 * thrown: the job's own outcome must not be replaced, and the claim lapses by its TTL.
 */
export const releaseReferenceClaims = async (claims: ReferenceClaim[], requestId: string): Promise<void> => {
    for (const { claimedAt, shardKey, threadId } of claims) {
        try {
            await callOnShard(internal.agent.file_attach_thread.endThreadAttach, { claimedAt, requestId, threadId: threadId as Id<"threads"> }, { shardKey });
        } catch (error) {
            chatLogger.error("[image_generation] Could not release a reference claim; it lapses by its TTL:", error);
        }
    }
};
