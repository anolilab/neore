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
import { callOnShard } from "../lib/cross-shard";
import { chatLogger } from "../lib/logger";
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
): Promise<boolean> => {
    const rows = await callOnShard(
        internal.chat.reference_gate.gateReferenceRowsOnCallerShard,
        { referenceIds, referenceImages, userId },
        { shardKey: userId },
    );

    if (rows.refused) {
        return false;
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
            return false;
        }
    }

    return true;
};

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
