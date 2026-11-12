/**
 * `/chat/start` with a `clientMessageId`: a client that resends after an ambiguous failure (a timeout, a dropped
 * connection, a 5xx after the save) gets the first send's answer, never a second prompt or a second thread.
 *
 * The send is a `chat-start` claim keyed `<userId>:<clientMessageId>` (`lib/claim-once.ts`), so one user's id never
 * matches another's. {@link claimChatStart} takes it before the daily charge; the save checks it and records the
 * saved ids on it in the SAME transaction as the prompt (`createThreadWithInitialMessage`, {@link saveStartPrompt}),
 * so a claim either has its ids or saved nothing; a text turn's stream is recorded the same way, in
 * `createStreamWithMessage` ({@link recordStartStream}). A later request with the id is answered from the record: a
 * duplicate, with a fresh token for the turn's stream (the reconnect path), or `in_progress` while the first has not
 * finished. After {@link CHAT_START_LEASE_MS} an unfinished send counts as dead: one with nothing saved is taken over
 * from scratch, a text turn saved without a stream is resumed from its saved prompt. Either way the claim gets a new
 * fence, so the dead send's late save or stream finds it moved and refuses.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { claimFence, claimRow, recordClaimResult } from "../lib/claim-once";
import { patchRow } from "../lib/patch";
import { MAX_LENGTH } from "../lib/validators";
import { getAgentForUser } from "./lib/thread-helpers";

/** The claim's scope. */
export const CHAT_START_SCOPE = "chat-start";

/** A day: covers any client's retries of one send, and the cron purge removes the row after. */
export const CHAT_START_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a send may take from its claim to its save before a retry counts it as dead and takes the claim over. */
export const CHAT_START_LEASE_MS = 2 * 60 * 1000;

/** Bounded, and the charset of a document id: no `:`, so `<userId>:<id>` is never ambiguous. */
const CLIENT_MESSAGE_ID_RE = new RegExp(String.raw`^[\w-]{1,${String(MAX_LENGTH.id)}}$`, "u");

export const isValidClientMessageId = (value: unknown): value is string => typeof value === "string" && CLIENT_MESSAGE_ID_RE.test(value);

/** The fence the save checks: the claim it took, by its key and `claimedAt`. */
export const vStartClaim = v.object({ claimedAt: v.number(), key: v.string().max(MAX_LENGTH.short) });

export type StartClaim = Infer<typeof vStartClaim>;

/** What a send recorded: its ids with the save, then its stream with the stream (a text turn). */
interface StartRecord {
    messageId: string;
    streamId?: string;
    threadId: string;
}

const vClaimOutcome = v.union(
    v.object({ claim: vStartClaim, outcome: v.literal("claimed") }),
    v.object({ outcome: v.literal("in_progress") }),
    v.object({
        messageId: v.string(),
        outcome: v.literal("duplicate"),
        streamId: v.optional(v.string()),
        threadId: v.string(),
    }),
    // A text turn saved but never queued, and past its lease: the caller makes its stream and run, and saves nothing.
    v.object({ claim: vStartClaim, messageId: v.string(), outcome: v.literal("resume"), threadId: v.string() }),
);

const startKey = (userId: string, clientMessageId: string): string => `${userId}:${clientMessageId}`;

const recordOf = (result: string): StartRecord => JSON.parse(result) as StartRecord;

/**
 * Takes the send, or says why not: `duplicate` with what the first send recorded, `in_progress` while the first send is
 * within its lease and has not finished (saved, and for a text turn `streams`, queued), or `resume` for a text turn
 * whose sender died between its save and its stream.
 */
export const claimChatStart = internalMutation
    .input({ clientMessageId: v.string().max(MAX_LENGTH.id), streams: v.boolean(), userId: v.string().max(MAX_LENGTH.id) })
    .output(vClaimOutcome)
    .mutation(async ({ args: { clientMessageId, streams, userId }, ctx }) => {
        const key = startKey(userId, clientMessageId);
        const existing = await claimRow(ctx, CHAT_START_SCOPE, key);
        const record = existing?.result === undefined ? undefined : recordOf(existing.result);

        if (record && (!streams || record.streamId !== undefined)) {
            return { ...record, outcome: "duplicate" as const };
        }

        if (existing && ctx.now - existing.claimedAt < CHAT_START_LEASE_MS) {
            return { outcome: "in_progress" as const };
        }

        if (existing && record) {
            // A new fence: the dead sender's stream, if it ever comes, finds the claim moved and refuses.
            await patchRow(ctx.db, "idempotencyClaims", existing, { claimedAt: ctx.now });

            return { claim: { claimedAt: ctx.now, key }, messageId: record.messageId, outcome: "resume" as const, threadId: record.threadId };
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

        return { claim: { claimedAt, key }, outcome: "claimed" as const };
    });

/** Gives the send back when it failed before its save. A claim with a saved record is kept: that send happened. */
export const releaseChatStart = internalMutation
    .input({ claim: vStartClaim })
    .output(v.null())
    .mutation(async ({ args: { claim }, ctx }) => {
        const existing = await claimRow(ctx, CHAT_START_SCOPE, claim.key);

        if (existing?.claimedAt === claim.claimedAt && existing.result === undefined) {
            await ctx.db.delete("idempotencyClaims", existing._id);
        }

        return null;
    });

/**
 * For the save's own transaction, before it writes: the claim must still be this send's with nothing saved under it.
 * Otherwise a retry took it over (this send was presumed dead) and the prompt must not be saved a second time.
 */
export const assertStartClaimHeld = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim): Promise<void> => {
    const existing = await claimRow(ctx, CHAT_START_SCOPE, claim.key);

    if (existing?.claimedAt !== claim.claimedAt || existing.result !== undefined) {
        throw new LunoraError("CONFLICT", "This message was already sent.");
    }
};

/** In the save's transaction, after it wrote: what a resend of this send answers with. */
export const recordStartSaved = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim, record: StartRecord): Promise<void> => {
    await recordClaimResult(ctx, CHAT_START_SCOPE, claim.key, claim.claimedAt, JSON.stringify(record));
};

/**
 * In `createStreamWithMessage`'s transaction: the claim must still be this send's, saved and with no stream yet, and the
 * stream is recorded on it, so a resend attaches to this run and a takeover never makes a second one.
 */
export const recordStartStream = async (ctx: Pick<MutationCtx, "db">, claim: StartClaim, streamId: string): Promise<void> => {
    const existing = await claimRow(ctx, CHAT_START_SCOPE, claim.key);
    const record = existing?.result === undefined ? undefined : recordOf(existing.result);

    if (existing?.claimedAt !== claim.claimedAt || !record || record.streamId !== undefined) {
        throw new LunoraError("CONFLICT", "This message was already sent.");
    }

    await patchRow(ctx.db, "idempotencyClaims", existing, { result: JSON.stringify({ ...record, streamId }) });
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
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ messageId: v.string() }))
    .mutation(async ({ args: { claim, fileIds, messageContent, model, parentId, threadId, userId }, ctx }) => {
        await assertStartClaimHeld(ctx, claim);

        const agent = await getAgentForUser(ctx, userId, model);
        const { messageId } = await agent.saveMessage(ctx, {
            fromUser: true,
            // Wire boundary, as in `createThreadWithInitialMessage`: AI SDK content parts the validator cannot express.
            message: { content: messageContent as never, role: "user" },
            ...(fileIds && fileIds.length > 0 && { metadata: { fileIds } }),
            promptMessageId: parentId,
            threadId,
        });

        await recordStartSaved(ctx, claim, { messageId, threadId });

        return { messageId };
    });
