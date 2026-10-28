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
import { streamLogger } from "../../lib/logger";
import type { HostChanges } from "./changes";
import { appendToTranscript, buildHostReply, emptyTranscript, isTranscriptFull, type HostReplyReason } from "./reply";
import { sessionOfThread, touchSession } from "./sessions";

type Stream = Doc<"persistentStreams">;

const CHUNK_PAGE = 200;

/**
 * The most chunk pages one finish reads from the front of a stream, and again from its end. Reasoning and tool
 * events do not fill the text cap, so without a bound a long turn would page through its whole history inside the
 * mutation that must save the reply and end the stream.
 */
export const MAX_TRANSCRIPT_PAGES = 25;

/** Pages read back from the end of a stream once the front budget is spent: a final answer after a long run of tool events lives there. */
export const MAX_TAIL_PAGES = 5;

/** Joins the front of a long turn to its end, so the reply says that the middle was left out. */
export const OMITTED_MARKER = "\n\n[… output omitted …]\n\n";

type ChunkRead = Pick<Doc<"persistentChunks">, "reasoning" | "seq" | "text">;

const appendChunks = (transcript: ReturnType<typeof emptyTranscript>, chunks: ChunkRead[]): void => {
    for (const chunk of chunks) {
        // Tool and permission events ride as `event` with no text of their own.
        if (chunk.text.length > 0 || chunk.reasoning) {
            appendToTranscript(transcript, chunk);
        }
    }
};

/**
 * What the host wrote to a stream, in order, up to the reply cap. Pages through the chunks and stops once the text
 * is full (reasoning after that point is not kept). When the page budget is spent first, the last pages are read
 * too and joined on after a marker, so the answer that follows a long run of tool events is not lost.
 */
export const readHostTranscript = async (ctx: Pick<MutationCtx, "db">, streamId: Id<"persistentStreams">) => {
    const transcript = emptyTranscript();
    let cursor: string | undefined;
    let pages = 0;
    let lastSeq = -1;
    let exhausted: boolean;

    do {
        pages += 1;
        const page = await ctx.db.persistentChunks.findMany({ cursor, limit: CHUNK_PAGE, orderBy: [{ seq: "asc" }], where: { streamId } });

        appendChunks(transcript, page.page);
        lastSeq = page.page.at(-1)?.seq ?? lastSeq;
        exhausted = page.isDone;
        cursor = exhausted || isTranscriptFull(transcript) || pages >= MAX_TRANSCRIPT_PAGES ? undefined : (page.continueCursor ?? undefined);
    } while (cursor);

    if (exhausted || isTranscriptFull(transcript)) {
        return transcript;
    }

    const tail: ChunkRead[] = [];
    let tailCursor: string | undefined;
    let reachedFront = false;

    for (let read = 0; read < MAX_TAIL_PAGES && !reachedFront; read += 1) {
        const page = await ctx.db.persistentChunks.findMany({ cursor: tailCursor, limit: CHUNK_PAGE, orderBy: [{ seq: "desc" }], where: { streamId } });

        tail.push(...page.page.filter((chunk) => chunk.seq > lastSeq));
        reachedFront = page.isDone || page.page.some((chunk) => chunk.seq <= lastSeq + 1);
        tailCursor = page.continueCursor ?? undefined;
    }

    if (tail.length > 0) {
        tail.reverse();

        if (!reachedFront && transcript.text.length > 0) {
            appendToTranscript(transcript, { text: OMITTED_MARKER });
        }

        appendChunks(transcript, tail);
    }

    return transcript;
};

/**
 * Saves the reply through the agent write surface, so branches apply: a regenerate points the thread at the
 * prompt first and fails the earlier pending step, which makes the new reply the prompt's SIBLING
 * (the rule `saveLocalTurnHandler` follows). Returns the saved row, or undefined when there was nothing to save.
 */
const saveHostReply = async (ctx: MutationCtx, stream: Stream, reason: HostReplyReason, error: string | undefined, changes: HostChanges | undefined): Promise<Id<"messages"> | undefined> => {
    const threadId = stream.threadId as Id<"threads">;
    const thread = await ctx.db.get(threadId);

    // The thread was deleted while the turn ran: a reply saved now would outlive its cleanup.
    if (!thread || thread.deleted) {
        return undefined;
    }

    // The prompt the reply answers is gone (a deleted message): saving would assert, and the reaper would
    // fail the whole shard tick on it.
    if (stream.messageId && !(await ctx.db.get(stream.messageId as Id<"messages">))) {
        return undefined;
    }

    const session = await sessionOfThread(ctx, threadId);
    const reply = buildHostReply({
        agentKey: session?.agentKey ?? "host",
        changes,
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
export const endHostTurn = async (ctx: MutationCtx, stream: Stream, end: { changes?: HostChanges; error?: string; reason: HostReplyReason }, now: number): Promise<boolean> => {
    if (!isLiveStream(stream)) {
        return false;
    }

    await saveHostReply(ctx, stream, end.reason, end.error, end.changes);

    return await endHostStream(ctx, stream, { reason: end.reason, status: STATUS_OF[end.reason] }, now);
};

/** The host's `turn_end` or Stop: {@link endHostTurn}, then the session is free again. */
export const finishHostTurn = async (ctx: MutationCtx, stream: Stream, end: { changes?: HostChanges; error?: string; reason: HostReplyReason }, now: number): Promise<boolean> => {
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

    try {
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
    } catch (error) {
        // Best effort, as above: the stream ends either way.
        streamLogger.warn("[acp] could not ask the host to cancel a turn", error);
    }
};

/** The sidebar's Stop for a host stream: keep what was written, end the stream, tell the host to cancel. */
export const stopHostTurn = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    if (await finishHostTurn(ctx, stream, { reason: "stopped" }, now)) {
        await sendHostCancel(ctx, stream, now);
    }
};
