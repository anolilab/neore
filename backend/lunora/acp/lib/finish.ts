/**
 * How a host turn ends, from every direction: the host's `turn_end`, the reaper, a revoked device and Stop. Each
 * saves the reply from the chunks written so far (a timeout or a revoke as a failed one, so the thread says why)
 * and ends the stream through `endHostStream` (status and `hostState: ended` in one write).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { patchThread } from "../../agent/table-writes";
import { endHostStream, isLiveStream } from "../../chat/streaming/persistent/host";
import { createAcpCancelCall } from "../../devices/lib/acp-call";
import { appendToTranscript, buildHostReply, emptyTranscript, isTranscriptFull, type HostReplyReason } from "./reply";
import { sessionOfThread, touchSession } from "./sessions";

type Stream = Doc<"persistentStreams">;

const CHUNK_PAGE = 200;

/** What the host wrote to a stream, in order, up to the reply cap. Pages through the chunks and stops once the text is full (reasoning after that point is not kept). */
export const readHostTranscript = async (ctx: Pick<MutationCtx, "db">, streamId: Id<"persistentStreams">) => {
    const transcript = emptyTranscript();
    let cursor: string | undefined;

    do {
        const page = await ctx.db.persistentChunks.findMany({ cursor, limit: CHUNK_PAGE, orderBy: [{ seq: "asc" }], where: { streamId } });

        for (const chunk of page.page) {
            // Tool and permission events ride as `event` with no text of their own.
            if (chunk.text.length > 0 || chunk.reasoning) {
                appendToTranscript(transcript, chunk);
            }
        }

        cursor = page.isDone || isTranscriptFull(transcript) ? undefined : (page.continueCursor ?? undefined);
    } while (cursor);

    return transcript;
};

/**
 * Saves the reply through the agent write surface, so branches apply: a regenerate points the thread at the
 * prompt first and fails the earlier pending step, which makes the new reply the prompt's SIBLING
 * (the rule `saveLocalTurnHandler` follows). Returns the saved row, or undefined when there was nothing to save.
 */
const saveHostReply = async (ctx: MutationCtx, stream: Stream, reason: HostReplyReason, error: string | undefined): Promise<Id<"messages"> | undefined> => {
    const threadId = stream.threadId as Id<"threads">;
    const thread = await ctx.db.get(threadId);

    // The thread was deleted while the turn ran: a reply saved now would outlive its cleanup.
    if (!thread || thread.deleted) {
        return undefined;
    }

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

const STATUS_OF: Record<HostReplyReason, "done" | "error" | "timeout"> = {
    cancelled: "done",
    failed: "error",
    finished: "done",
    interrupted: "error",
    revoked: "error",
    stopped: "done",
    timeout: "timeout",
};

/**
 * Saves the reply and ends the stream, whoever ends it. A stream that already ended is left alone (false). The
 * session is not touched: the caller knows whether it goes idle (a turn's end) or is already ended (a revoke).
 */
export const endHostTurn = async (ctx: MutationCtx, stream: Stream, end: { error?: string; reason: HostReplyReason }, now: number): Promise<boolean> => {
    if (!isLiveStream(stream)) {
        return false;
    }

    await saveHostReply(ctx, stream, end.reason, end.error);

    return await endHostStream(ctx, stream, { reason: end.reason, status: STATUS_OF[end.reason] }, now);
};

/** The host's `turn_end` or Stop: {@link endHostTurn}, then the session is free again. */
export const finishHostTurn = async (ctx: MutationCtx, stream: Stream, end: { error?: string; reason: HostReplyReason }, now: number): Promise<boolean> => {
    const ended = await endHostTurn(ctx, stream, end, now);

    if (ended) {
        const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

        if (session) {
            await touchSession(ctx, session, "idle", now);
        }
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
