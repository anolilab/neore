/**
 * The reference images of a media request (`/chat/media`), checked in two steps.
 *
 * 1. `gateReferenceRowsOnCallerShard`, on the CALLER's shard: each id is the caller's own row, and the request's URL is that
 *    row's URL. The caller's files and documents live there, and each names the chat it sits in (`chatIds`).
 * 2. `threadReadableOnShard`, on each chat's OWNER's shard (`referenceChatsRefused` in `chat/http.ts` reaches it through
 *    `threadShardFor`): the caller may read that chat. A shared chat, and its passcode rows, live on the owner's shard. The
 *    request's unlock proof applies only to the chat it generates into.
 */
import { REFERENCE_MEDIA_CAPS } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { FILE_ATTACH_THREAD_SCOPE, FILE_ATTACH_TTL_MS } from "../agent/file-attach-claim";
import { claimFence } from "../lib/claim-once";
import { isThreadLocked } from "../lib/thread-lock";
import { MAX_LENGTH } from "../lib/validators";
import { lockedAfterCreation, threadGateOutcome } from "./lib/thread-gate";

const REFERENCE_ID = /^(file|doc):([\w-]+)$/u;

/** Whether one reference is the caller's own row under its own URL, and the chat that row sits in (if any). */
const rowChecked = async (
    ctx: Pick<QueryCtx, "db">,
    { referenceId, referenceUrl, userId }: { referenceId: string; referenceUrl: string; userId: string },
): Promise<{ chatId: string | undefined; refused: boolean }> => {
    const match = REFERENCE_ID.exec(referenceId);

    if (!match) {
        return { chatId: undefined, refused: true };
    }

    const [, kind = "", rowId = ""] = match;

    if (kind === "file") {
        const file = await ctx.db.get("files", rowId as Id<"files">);

        if (!file || file.userId !== userId || file.url !== referenceUrl) {
            return { chatId: undefined, refused: true };
        }

        return { chatId: file.chatId, refused: false };
    }

    const document = await ctx.db.get("documents", rowId as Id<"documents">);

    if (!document || document.userId !== userId || document.content !== referenceUrl) {
        return { chatId: undefined, refused: true };
    }

    return { chatId: document.threadId, refused: false };
};

/** Step 1: every id is the caller's own row under its own URL. Ids and URLs are paired by position; the caller checks the counts. */
export const gateReferenceRowsOnCallerShard = internalQuery
    .input({
        referenceIds: v.array(v.string().max(MAX_LENGTH.id)),
        referenceImages: v.array(v.string()),
        userId: v.string(),
    })
    .output(v.object({ chatIds: v.array(v.string()), refused: v.boolean() }))
    .query(async ({ args, ctx }) => {
        // Refused before any read: the list is caller-controlled and the reads below run once per entry.
        if (args.referenceIds.length > REFERENCE_MEDIA_CAPS.images || args.referenceImages.length > REFERENCE_MEDIA_CAPS.images) {
            return { chatIds: [], refused: true };
        }

        const chatIds: string[] = [];

        for (const [index, referenceId] of args.referenceIds.entries()) {
            const row = await rowChecked(ctx, { referenceId, referenceUrl: args.referenceImages[index] ?? "", userId: args.userId });

            if (row.refused) {
                return { chatIds: [], refused: true };
            }

            if (row.chatId !== undefined) {
                chatIds.push(row.chatId);
            }
        }

        return { chatIds: [...new Set(chatIds)], refused: false };
    });

/**
 * Step 2, on the chat's owner's shard: whether the caller may read the thread. The unlock proof is the caller's passcode proof for
 * THIS thread only; a reference's other locked chats need their own proof, which the request does not carry.
 */
export const threadReadableOnShard = internalQuery
    .input({
        threadId: v.string().max(MAX_LENGTH.id),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(v.object({ readable: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const outcome = await threadGateOutcome(ctx, {
            level: "read",
            threadId: args.threadId as Id<"threads">,
            unlockProof: args.unlockProof,
            userId: args.userId,
        });

        return { readable: outcome === "ok" };
    });

/**
 * Whether a referenced chat is still held by the caller for a reference checked at `requestedAt`. The job carries no unlock proof.
 * A chat locked when the request was checked was read with that request's proof, so it is still held only while the caller owns it
 * and the lock predates the check. A chat locked since the check is not held, and an unlocked one is held only while the caller may
 * still read it.
 */
const chatHeld = async (ctx: Pick<QueryCtx, "db">, { requestedAt, threadId, userId }: { requestedAt: number; threadId: string; userId: string }) => {
    const thread = await ctx.db.get("threads", threadId as Id<"threads">);

    if (!thread) {
        return false;
    }

    if (isThreadLocked(thread)) {
        return thread.userId === userId && !lockedAfterCreation(thread, requestedAt);
    }

    return (await threadGateOutcome(ctx, { level: "read", threadId: threadId as Id<"threads">, userId })) === "ok";
};

/** {@link chatHeld} as a read, for a caller that only asks. */
export const chatHeldOnShard = internalQuery
    .input({
        requestedAt: v.number(),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string(),
    })
    .output(v.object({ held: v.boolean() }))
    .query(async ({ args, ctx }) => {
        return { held: await chatHeld(ctx, args) };
    });

/**
 * {@link chatHeld} as the job's recheck. For an unlocked chat the caller may read, it also holds the chat against a lock until the
 * job is done: an attach claim on the chat's owner shard (`agent/file-attach-thread.ts`), which `enableThreadLock` refuses while it is
 * held. The claim is taken in the same transaction as the check, so no lock can commit between the two. A locked chat needs no hold,
 * since it is already closed to new attaches. The claim is released by `endThreadAttach` (`chat/reference-recheck.ts`).
 */
export const holdReferenceChatOnShard = internalMutation
    .input({
        requestedAt: v.number(),
        requestId: v.string().max(MAX_LENGTH.id),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string(),
    })
    .output(v.object({ claimedAt: v.optional(v.number()), held: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!(await chatHeld(ctx, args))) {
            return { held: false };
        }

        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (thread && isThreadLocked(thread)) {
            return { held: true };
        }

        const claimedAt = await claimFence(ctx, FILE_ATTACH_THREAD_SCOPE, `${args.threadId}:${args.requestId}`, {
            ttlMs: FILE_ATTACH_TTL_MS,
            userId: args.userId,
        });

        // A request id is unique per attempt, so a held key is not expected. Refusing the chat fails the job closed.
        return claimedAt === null ? { held: false } : { claimedAt, held: true };
    });
