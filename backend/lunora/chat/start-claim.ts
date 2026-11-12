/**
 * `/chat/start` with a `clientMessageId`: a client that resends after an ambiguous failure (a timeout, a dropped
 * connection, a 5xx after the save) gets the first send's answer, never a second prompt or a second thread.
 *
 * The send is a `chat-start` claim keyed `<userId>:<clientMessageId>` (`lib/claim-once.ts`), so one user's id never
 * matches another's. {@link claimChatStart} takes it before the daily charge, with the request's fingerprint
 * ({@link chatStartFingerprint}): the same id on a different send is refused, never answered with the first send's ids.
 * The save checks the claim and records the saved ids on it in the SAME transaction as the thread and the prompt, with no
 * nested mutation (`createThreadWithInitialMessage`, {@link saveStartPrompt}), so a claim either has its ids or saved
 * nothing; a text turn's goal and stream are recorded the same way, in `startGoal` ({@link recordStartGoal}) and
 * `createStreamWithMessage` ({@link recordStartStream}). A
 * later request with the id is answered from the record: a duplicate, with a fresh token for the turn's stream (the
 * reconnect path), or `in_progress` while the first has not finished. After {@link CHAT_START_LEASE_MS} an unfinished
 * send counts as dead: one with nothing saved is taken over from scratch, a text turn saved without a stream is resumed
 * from its saved prompt. Either way the claim gets a new fence, so the dead send's late save, goal or stream finds it
 * moved and refuses.
 *
 * The claim lives on the shard `/chat/start` runs on, the thread owner's: the save must check it in its own
 * transaction, and a transaction never spans two shards. A resend names the same thread (the fingerprint binds it), so
 * it reaches the same claim; one id used for sends into two owners' chats is two sends.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { claimFence, claimRow, recordClaimResult } from "../lib/claim-once";
import { sha256Hex } from "../lib/crypto";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { savePromptInTransaction } from "./lib/save-prompt";
import { canClaimStreamRun } from "./streaming/persistent/library";

/** The claim's scope. */
export const CHAT_START_SCOPE = "chat-start";

/** A day: covers any client's retries of one send, and the cron purge removes the row after. */
export const CHAT_START_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a send may take from its claim to its save before a retry counts it as dead and takes the claim over. */
export const CHAT_START_LEASE_MS = 2 * 60 * 1000;

/** Bounded, and the charset of a document id: no `:`, so `<userId>:<id>` is never ambiguous. */
const CLIENT_MESSAGE_ID_RE = new RegExp(String.raw`^[\w-]{1,${String(MAX_LENGTH.id)}}$`, "u");

export const isValidClientMessageId = (value: unknown): value is string => typeof value === "string" && CLIENT_MESSAGE_ID_RE.test(value);

/** What makes two requests the same send: where it goes, what it saves, and whether it streams or starts a goal. */
export interface ChatStartRequest {
    contentType: "image" | "text" | "video";
    fileIds?: string[];
    goal?: string;
    guestMessageId?: string;
    parentId?: string;
    prompt?: string;
    /** The existing thread, or none for a new chat. */
    threadId?: string;
}

/** A digest of {@link ChatStartRequest}, in a fixed field order. */
export const chatStartFingerprint = async (request: ChatStartRequest): Promise<string> =>
    await sha256Hex(
        JSON.stringify([
            request.threadId ?? null,
            request.contentType,
            request.prompt ?? null,
            request.fileIds ?? [],
            request.guestMessageId ?? null,
            request.parentId ?? null,
            request.goal ?? null,
        ]),
    );

/** The fence the save checks: the claim it took, by its key and `claimedAt`. */
export const vStartClaim = v.object({ claimedAt: v.number(), key: v.string().max(MAX_LENGTH.short) });

export type StartClaim = Infer<typeof vStartClaim>;

/** The claim's `result`: the send's fingerprint from the claim on, its ids with the save, then its goal and stream with them (a text turn). */
interface StartRecord {
    fingerprint: string;
    /** The goal the send started: a resumed send runs it, and starts no second one. */
    goalId?: string;
    messageId?: string;
    /** The save created the thread: a resumed send schedules a new chat's title jobs. */
    newThread?: boolean;
    streamId?: string;
    threadId?: string;
}

type SavedRecord = StartRecord & { messageId: string; threadId: string };

const vClaimOutcome = v.union(
    v.object({ claim: vStartClaim, outcome: v.literal("claimed") }),
    v.object({ outcome: v.literal("in_progress") }),
    // The id was used for a different send.
    v.object({ outcome: v.literal("mismatch") }),
    v.object({
        messageId: v.string(),
        outcome: v.literal("duplicate"),
        streamId: v.optional(v.string()),
        /** The stream has no run yet (its queue submission may have failed): the caller queues it again, which a run claims once. */
        streamUnclaimed: v.optional(v.boolean()),
        threadId: v.string(),
    }),
    // A text turn saved but never queued, and past its lease: the caller makes its stream and run, and saves nothing.
    v.object({
        claim: vStartClaim,
        messageId: v.string(),
        newThread: v.optional(v.boolean()),
        outcome: v.literal("resume"),
        threadId: v.string(),
    }),
);

const startKey = (userId: string, clientMessageId: string): string => `${userId}:${clientMessageId}`;

const recordOf = (result: string | undefined): StartRecord | undefined => (result === undefined ? undefined : (JSON.parse(result) as StartRecord));

const isSaved = (record: StartRecord | undefined): record is SavedRecord => record?.messageId !== undefined && record.threadId !== undefined;

/** Whether a stream recorded on a claim still waits for its run. */
const streamUnclaimed = async (ctx: Pick<MutationCtx, "db">, streamId: string): Promise<boolean> =>
    canClaimStreamRun(await ctx.db.get("persistentStreams", streamId as Id<"persistentStreams">));

/**
 * Takes the send, or says why not: `mismatch` when the id was used for a different send, `duplicate` with what the first
 * send recorded, `in_progress` while the first send is within its lease and has not finished (saved, and for a text turn
 * `streams`, given its stream), or `resume` for a text turn whose sender died between its save and its stream.
 */
export const claimChatStart = internalMutation
    .input({
        clientMessageId: v.string().max(MAX_LENGTH.id),
        fingerprint: v.string().max(MAX_LENGTH.short),
        streams: v.boolean(),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(vClaimOutcome)
    .mutation(async ({ args: { clientMessageId, fingerprint, streams, userId }, ctx }) => {
        const key = startKey(userId, clientMessageId);
        const existing = await claimRow(ctx, CHAT_START_SCOPE, key);
        const record = recordOf(existing?.result);

        if (existing && record?.fingerprint !== fingerprint) {
            return { outcome: "mismatch" as const };
        }

        if (isSaved(record) && (!streams || record.streamId !== undefined)) {
            const { messageId, streamId, threadId } = record;

            return {
                messageId,
                outcome: "duplicate" as const,
                ...(streamId !== undefined && { streamId, ...((await streamUnclaimed(ctx, streamId)) && { streamUnclaimed: true }) }),
                threadId,
            };
        }

        if (existing && ctx.now - existing.claimedAt < CHAT_START_LEASE_MS) {
            return { outcome: "in_progress" as const };
        }

        if (existing && isSaved(record)) {
            // A new fence: the dead sender's goal or stream, if it ever comes, finds the claim moved and refuses.
            await patchRow(ctx.db, "idempotencyClaims", existing, { claimedAt: ctx.now });

            return {
                claim: { claimedAt: ctx.now, key },
                messageId: record.messageId,
                ...(record.newThread === true && { newThread: true }),
                outcome: "resume" as const,
                threadId: record.threadId,
            };
        }

        if (existing) {
            // Lapsed with nothing saved: that send died before its save.
            await ctx.db.delete("idempotencyClaims", existing._id);
        }

        const claimedAt = await claimFence(ctx, CHAT_START_SCOPE, key, { ttlMs: CHAT_START_CLAIM_TTL_MS, userId });

        // Unreachable: the key was free or just freed in this transaction.
        if (claimedAt === null) {
            return { outcome: "in_progress" as const };
        }

        await recordClaimResult(ctx, CHAT_START_SCOPE, key, claimedAt, JSON.stringify({ fingerprint } satisfies StartRecord));

        return { claim: { claimedAt, key }, outcome: "claimed" as const };
    });

/** Gives the send back when it failed before its save. A claim with saved ids is kept: that send happened. */
export const releaseChatStart = internalMutation
    .input({ claim: vStartClaim })
    .output(v.null())
    .mutation(async ({ args: { claim }, ctx }) => {
        const existing = await claimRow(ctx, CHAT_START_SCOPE, claim.key);

        if (existing?.claimedAt === claim.claimedAt && !isSaved(recordOf(existing.result))) {
            await ctx.db.delete("idempotencyClaims", existing._id);
        }

        return null;
    });

/** The claim row and its record while `claim` still holds it, or a refusal: a retry took the send over (this one was presumed dead). */
const heldClaim = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim) => {
    const existing = await claimRow(ctx, CHAT_START_SCOPE, claim.key);
    const record = recordOf(existing?.result);

    if (!existing || !record || existing.claimedAt !== claim.claimedAt) {
        throw new LunoraError("CONFLICT", "This message was already sent.");
    }

    return { existing, record };
};

/** For the save's own transaction, before it writes: the claim must still be this send's with nothing saved under it. */
export const assertStartClaimHeld = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim): Promise<void> => {
    const { record } = await heldClaim(ctx, claim);

    if (isSaved(record)) {
        throw new LunoraError("CONFLICT", "This message was already sent.");
    }
};

/** In the save's transaction, after it wrote: what a resend of this send answers with. */
export const recordStartSaved = async (
    ctx: Pick<MutationCtx, "db">,
    claim: StartClaim,
    saved: { messageId: string; newThread?: boolean; threadId: string },
): Promise<void> => {
    const { existing, record } = await heldClaim(ctx, claim);

    await patchRow(ctx.db, "idempotencyClaims", existing, { result: JSON.stringify({ ...record, ...saved } satisfies StartRecord) });
};

/**
 * Before anything a text turn writes after its save (its goal, its stream): the claim must still be this send's, saved
 * and with no stream yet. A sender whose claim was taken over writes nothing, so it cannot supersede the retry's goal.
 */
export const assertStartStreamable = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim) => {
    const held = await heldClaim(ctx, claim);

    if (!isSaved(held.record) || held.record.streamId !== undefined) {
        throw new LunoraError("CONFLICT", "This message was already sent.");
    }

    return held;
};

/**
 * In `startGoal`'s transaction, before it starts one: the goal a takeover of this send already started, if any. A
 * resumed send runs that goal; superseding it with a copy would end the goal its prompt opened.
 */
export const startedGoalOf = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim): Promise<Id<"threadGoals"> | undefined> => {
    const { record } = await assertStartStreamable(ctx, claim);

    return record.goalId as Id<"threadGoals"> | undefined;
};

/** In `startGoal`'s transaction, after its insert: the goal is recorded on the claim, so a resumed send reuses it. */
export const recordStartGoal = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim, goalId: string): Promise<void> => {
    const { existing, record } = await assertStartStreamable(ctx, claim);

    await patchRow(ctx.db, "idempotencyClaims", existing, { result: JSON.stringify({ ...record, goalId } satisfies StartRecord) });
};

/**
 * In `createStreamWithMessage`'s transaction: the claim must still be this send's, saved and with no stream yet, and the
 * stream is recorded on it, so a resend attaches to this run and a takeover never makes a second one.
 */
export const recordStartStream = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim, streamId: string): Promise<void> => {
    const { existing, record } = await assertStartStreamable(ctx, claim);

    await patchRow(ctx.db, "idempotencyClaims", existing, { result: JSON.stringify({ ...record, streamId } satisfies StartRecord) });
};

/**
 * The prompt of a send into an existing thread, saved under its claim in one transaction. `/chat/start` without a
 * `clientMessageId` saves from the HTTP action as before.
 */
export const saveStartPrompt = internalMutation
    .input({
        claim: vStartClaim,
        fileIds: v.optional(v.array(v.string().max(MAX_LENGTH.id))),
        messageContent: v.array(v.record(v.string(), v.any())),
        model: v.string().max(MAX_LENGTH.short),
        parentId: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ messageId: v.string() }))
    .mutation(async ({ args: { claim, fileIds, messageContent, model, parentId, threadId }, ctx }) => {
        await assertStartClaimHeld(ctx, claim);

        const messageId = await savePromptInTransaction(ctx, {
            // Wire boundary: `messageContent` is declared as untyped records, the AI SDK content parts the validator cannot express.
            content: messageContent as unknown as Parameters<typeof savePromptInTransaction>[1]["content"],
            ...(fileIds && fileIds.length > 0 && { fileIds }),
            fromUser: true,
            model,
            ...(parentId !== undefined && { parentId }),
            threadId,
        });

        await recordStartSaved(ctx, claim, { messageId, threadId });

        return { messageId };
    });
