/**
 * Steering a running reply: a message the user sends while the reply streams,
 * delivered INTO that reply at its next step boundary instead of after it.
 *
 * - `steerRun` queues the text on the run's `persistentStreams` row.
 * - At each step boundary the run calls `deliverSteers` (`lib/agent-run.ts`
 *   `createRunSteering`, via the agent's `prepareStep`). It takes every queued
 *   text as one user message, writes it into the thread
 *   (`agent/steer-rows.ts`), and the model sees it from that step on.
 * - When the stream ends, the client calls `withdrawSteer` for each steer it is
 *   still showing. `withdrawn` means it was never delivered and the client sends
 *   it as an ordinary message. `delivered` means the reply already has it.
 *
 * A text-only reply has no step boundary, so a steer sent during one is always
 * withdrawn and sent after it, as the queue would have done.
 *
 * Only the run's own user may steer it, and only an interactive run: the
 * delivery hook exists in the non-group paths of `chat/execute.ts` alone, and a
 * group thread is refused here so its composer falls back to the queue.
 *
 * A steer is not charged to the daily message quota: it is delivered only at a
 * step boundary of a run already under way, and whatever it makes the run do
 * stays bounded by that run's `maxSteps`, charged when the run started. A
 * withdrawn steer is charged when the client sends it through `/chat/start`.
 * The model's content-safety check covers it there too: the gateway checks
 * every model call's user text (`/internal/model/proxy`), steered text included.
 */
import { LunoraError, v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { insertSteerRow } from "../agent/steer-rows";
import { authMutation, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { queueSteer, type SteerEntry, takeQueuedSteers, withdrawQueuedSteer } from "./lib/steer-queue";
import { lockedAfterCreation, threadGateOutcome, throwUnlessGranted } from "./lib/thread-gate";

const isLive = (status: string): boolean => status === "pending" || status === "streaming";

export const steerRun = authMutation
    .use(rateLimit("chat/steer"))
    .input({
        /**
         * The client's id for this steer. Sending the same id again queues nothing
         * more, so a call whose answer was lost can be reconciled instead of repeated.
         */
        steerId: v.optional(v.string().max(MAX_LENGTH.id)),
        streamId: v.id("persistentStreams"),
        text: v.string().max(MAX_LENGTH.text),
        threadId: v.id("threads"),
        /** A locked chat's passcode proof; the client adds it to every call that names the thread. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ steerId: v.string() }))
    .mutation(async ({ args: { steerId: requestedId, streamId, text: rawText, threadId, unlockProof }, ctx }) => {
        const { userId } = ctx.user;
        const text = rawText.trim();

        if (!text) {
            throw new LunoraError("BAD_REQUEST", "There is nothing to send");
        }

        // The same gate as every other write to the chat: a locked chat needs its proof.
        throwUnlessGranted(await threadGateOutcome(ctx, { level: "write", threadId, unlockProof, userId }), "Write access denied to this thread");

        // Admitted by the gate above, so readable through row-level security.
        const thread = await ctx.db.threads.findFirst({ where: { _id: threadId } });

        if (thread?.groupChat && thread.groupChat.participants.length > 0) {
            throw new LunoraError("CONFLICT", "A group chat reply cannot be steered");
        }

        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } });

        // The run's own user only: in a shared thread, a collaborator does not
        // steer the reply someone else asked for.
        if (!stream || stream.threadId !== threadId || stream.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Reply not found");
        }

        if (!isLive(stream.status) || stream.streamingConfig.contentType !== "text") {
            throw new LunoraError("CONFLICT", "This reply is no longer running");
        }

        // A repeat of a steer the run already holds (queued or taken) is answered, not queued again.
        if (requestedId && stream.steers?.some((entry) => entry.id === requestedId)) {
            return { steerId: requestedId };
        }

        const steerId = requestedId ?? crypto.randomUUID();
        const steers = queueSteer(stream.steers ?? [], { id: steerId, text });

        if (!steers) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Wait for the reply to take the messages already sent");
        }

        await ctx.db.patch(stream._id, { steers });

        ctx.log.event("chat.steer_run", { queued: steers.filter((entry) => entry.status === "queued").length });

        return { steerId };
    });

export const withdrawSteer = authMutation
    .use(rateLimit("chat/steer"))
    .input({
        steerId: v.string().max(MAX_LENGTH.id),
        streamId: v.id("persistentStreams"),
        threadId: v.id("threads"),
        /** A locked chat's passcode proof, as `steerRun` takes it. */
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(v.object({ outcome: v.union(v.literal("withdrawn"), v.literal("delivered"), v.literal("unknown")) }))
    .mutation(async ({ args: { steerId, streamId, threadId, unlockProof }, ctx }) => {
        const gate = await threadGateOutcome(ctx, { level: "write", threadId, unlockProof, userId: ctx.user.userId });

        // A locked chat's queue is its content: no proof, no change. Anything else the
        // gate refuses reads like a missing stream, as it does for someone else's.
        if (gate === "locked") {
            throwUnlessGranted(gate);
        }

        const stream = gate === "ok" ? await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } }) : undefined;

        // Someone else's stream reads exactly like a missing one.
        if (!stream || stream.threadId !== threadId || stream.userId !== ctx.user.userId) {
            return { outcome: "unknown" as const };
        }

        const { entries, outcome } = withdrawQueuedSteer(stream.steers ?? [], steerId);

        if (outcome === "withdrawn") {
            await ctx.db.patch(stream._id, { steers: entries });
        }

        ctx.log.event("chat.withdraw_steer", { outcome });

        return { outcome };
    });

/**
 * The run's step-boundary hook: every queued steer, written as one user message
 * under the reply so far, with the run's pending row moved after it. `null`
 * when nothing is queued, when the stream is not the run's, when the chat was
 * locked after the run started, or when the rows refuse the move (`insertSteerRow`); the steers then stay queued.
 */
export const deliverSteers = internalMutation
    .input({
        pendingMessageId: v.string().max(MAX_LENGTH.id),
        streamId: v.id("persistentStreams"),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.union(v.null(), v.object({ messageId: v.string(), text: v.string() })))
    .mutation(async ({ args: { pendingMessageId, streamId, threadId, userId }, ctx }) => {
        const stream = await ctx.db.persistentStreams.findFirst({ where: { _id: streamId } });

        if (!stream?.steers || stream.threadId !== threadId || stream.userId !== userId || !isLive(stream.status)) {
            return null;
        }

        // A chat locked after this run started has no proof behind the run any more: the
        // steer stays queued, for the client to withdraw with a proof.
        const thread = await ctx.db.get(threadId);

        if (!thread || lockedAfterCreation(thread, stream._creationTime)) {
            return null;
        }

        const taken = takeQueuedSteers(stream.steers as SteerEntry[]);

        if (!taken) {
            return null;
        }

        const row = await insertSteerRow(ctx, { pendingMessageId, text: taken.text, threadId, userId });

        if (!row) {
            return null;
        }

        await ctx.db.patch(stream._id, { steers: taken.deliver(row.messageId) });

        return { messageId: row.messageId, text: taken.text };
    });
