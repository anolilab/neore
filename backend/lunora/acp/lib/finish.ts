/**
 * How a host turn ends, from every direction: the host's `turn_end`, the reaper, a revoked device and Stop. Each
 * ends the stream through `endHostStream` (status and `hostState: ended` in one write); the host's own end and
 * Stop also save the reply from the chunks written so far.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { patchThread } from "../../agent/table-writes";
import { endHostStream } from "../../chat/streaming/persistent/host";
import { createAcpCancelCall } from "../../devices/lib/acp-call";
import { appendToTranscript, buildHostReply, emptyTranscript, type HostReplyReason } from "./reply";
import { sessionOfThread, touchSession } from "./sessions";

type Stream = Doc<"persistentStreams">;

/** Everything the host wrote to a stream, in order. */
export const readHostTranscript = async (ctx: Pick<MutationCtx, "db">, streamId: Id<"persistentStreams">) => {
    const transcript = emptyTranscript();
    const { page } = await ctx.db.persistentChunks.findMany({ orderBy: [{ seq: "asc" }], where: { streamId } });

    for (const chunk of page) {
        appendToTranscript(transcript, chunk);
    }

    return transcript;
};

/**
 * Saves the reply through the agent write surface, so branches apply: a regenerate points the thread at the
 * prompt first and fails the earlier pending step, which makes the new reply the prompt's SIBLING
 * (the rule `saveLocalTurnHandler` follows). Returns the saved row, or undefined when there was nothing to save.
 */
const saveHostReply = async (ctx: MutationCtx, stream: Stream, reason: HostReplyReason, error: string | undefined): Promise<Id<"messages"> | undefined> => {
    const threadId = stream.threadId as Id<"threads">;
    const session = await sessionOfThread(ctx, threadId);
    const reply = buildHostReply({
        agentKey: session?.agentKey ?? "host",
        error,
        reason,
        transcript: await readHostTranscript(ctx, stream._id),
    });

    if (!reply) {
        return undefined;
    }

    const promptMessageId = stream.messageId as Id<"messages">;
    const regenerate = stream.hostRegenerate === true;

    if (regenerate) {
        await patchThread(ctx.db, threadId, { activeLeafMessageId: promptMessageId });
    }

    const { messages } = await addMessagesHandler(ctx, { failPendingSteps: regenerate, messages: [reply], promptMessageId, threadId, userId: stream.userId });

    return messages[0]?._id as Id<"messages"> | undefined;
};

/** The host's `turn_end`: save the reply, end the stream, free the session. A stream that already ended is left alone. */
export const finishHostTurn = async (ctx: MutationCtx, stream: Stream, end: { error?: string; reason: HostReplyReason }, now: number): Promise<boolean> => {
    if (stream.status !== "pending" && stream.status !== "streaming") {
        return false;
    }

    await saveHostReply(ctx, stream, end.reason, end.error);

    const failed = end.reason === "failed" || end.reason === "interrupted";
    const ended = await endHostStream(ctx, stream, { reason: end.reason, status: failed ? "error" : "done" }, now);
    const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

    if (session) {
        await touchSession(ctx, session, "idle", now);
    }

    return ended;
};

/** Asks the stream's host to stop the turn. Best effort: a refusal (budget, device gone) leaves the stream ended all the same. */
export const sendHostCancel = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    if (!stream.hostTurnId) {
        return;
    }

    const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

    if (!session || session.status === "ended") {
        return;
    }

    await createAcpCancelCall(
        ctx,
        {
            deviceId: session.deviceId,
            hostSessionId: session.hostSessionId,
            threadId: stream.threadId as Id<"threads">,
            turnId: stream.hostTurnId,
            userId: stream.userId,
        },
        now,
    );
};

/** The sidebar's Stop for a host stream: keep what was written, end the stream, tell the host to cancel. */
export const stopHostTurn = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    if (await finishHostTurn(ctx, stream, { reason: "stopped" }, now)) {
        await sendHostCancel(ctx, stream, now);
    }
};
