/**
 * An in-flight file attach, on the thread OWNER's shard.
 *
 * The caller's claim (`agent/file-attach-claim.ts`) keeps the caller from locking their own chats while a file they read is in
 * flight. It cannot see a lock of the chat the file goes INTO: that lock is written on the owner's shard, and the owner's lock
 * checks only their own claims. So an attach also takes this claim on the destination's shard, in the same transaction that
 * checks the thread's access and lock (`threadGateOutcome`). `enableThreadLock` refuses while one is held
 * (`agent/thread-lock.ts`), so no lock of the chat commits between that check and the save. Same shape as the title dispatch
 * claim (`chat/lib/thread-gate.ts`, `agent/thread-title.ts`).
 */
import { LunoraError, v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { threadGateOutcome } from "../chat/lib/thread-gate";
import { claimFence, releaseClaim } from "../lib/claim-once";
import { MAX_LENGTH } from "../lib/validators";
import { FILE_ATTACH_THREAD_SCOPE, FILE_ATTACH_TTL_MS } from "./file-attach-claim";

/**
 * The thread's access and lock check and the attach's claim, in one transaction. The claim is taken only when the gate says
 * `ok`; a locked or denied chat answers with that outcome and holds nothing.
 */
export const claimThreadAttach = internalMutation
    .input({
        requestId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(v.object({ claimedAt: v.optional(v.number()), outcome: v.union(v.literal("denied"), v.literal("locked"), v.literal("ok")) }))
    .mutation(async ({ args, ctx }) => {
        const outcome = await threadGateOutcome(ctx, { level: "write", threadId: args.threadId, unlockProof: args.unlockProof, userId: args.userId });

        if (outcome !== "ok") {
            return { outcome };
        }

        const claimedAt = await claimFence(ctx, FILE_ATTACH_THREAD_SCOPE, `${args.threadId}:${args.requestId}`, {
            ttlMs: FILE_ATTACH_TTL_MS,
            userId: args.userId,
        });

        // A request id is unique per attach, so a held key is not expected. Throwing refuses the attach (fail closed).
        if (claimedAt === null) {
            throw new LunoraError("CONFLICT", "The file attach is already in progress.");
        }

        return { claimedAt, outcome };
    });

/** Releases the claim `claimThreadAttach` took, once the attach's message is saved. A claim that is no longer the attach's is left alone. */
export const endThreadAttach = internalMutation
    .input({ claimedAt: v.number(), requestId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await releaseClaim(ctx, FILE_ATTACH_THREAD_SCOPE, `${args.threadId}:${args.requestId}`, args.claimedAt);

        return null;
    });
