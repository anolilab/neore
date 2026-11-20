/**
 * The job-time recheck of a media request's references (`generateImage`), run before the provider call. The job runs on the
 * thread owner's shard, so the caller's rows are read on the caller's shard and each referenced chat on its owner's shard, the
 * same two steps as the request (`chat/reference-gate.ts`). A lock or grant that changed after the request refuses the job here.
 */
import { internal } from "../_generated/internal";
import { callOnShard } from "../lib/cross-shard";
import { threadShardFor } from "../lib/thread-shard";

/** Whether every reference is still the caller's own row under its URL, and every chat it sits in is still held by the caller. */
export const referencesStillHeld = async (
    context: Parameters<typeof threadShardFor>[0],
    { referenceIds, referenceImages, requestedAt, userId }: { referenceIds: string[]; referenceImages: string[]; requestedAt: number; userId: string },
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
        const { held } = await callOnShard(internal.chat.reference_gate.chatHeldOnShard, { requestedAt, threadId: chatId, userId }, { shardKey });

        if (!held) {
            return false;
        }
    }

    return true;
};
