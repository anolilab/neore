/**
 * How a host turn ends, from every direction: the host's `turn_end`, the reaper, a revoked device and Stop. Each
 * saves the reply from the chunks written so far (a timeout or a revoke as a failed one, so the thread says why)
 * and ends the stream through `endHostStream` (status and `hostState: ended` in one write).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { addMessagesHandler } from "../../agent/messages";
import { patchThread } from "../../agent/table-writes";
import { endHostStream, isLiveStream } from "../../chat/streaming/persistent/host";
import { createAcpCancelCall } from "../../devices/lib/acp-call";
import { streamLogger } from "../../lib/logger";
import { settleHostGuide } from "../../source-control/guide-host-end";
import { findRunningHostRun } from "../../sub-agents/host-runs";
import type { SubAgentOutcome } from "../../sub-agents/functions";
import { isWorkerThread } from "../../sub-agents/worker-thread";
import type { HostChanges } from "./changes";
import {
    addMediaToTranscript,
    appendChildEvent,
    appendToTranscript,
    buildHostReply,
    emptyTranscript,
    isChildEvent,
    isTranscriptFull,
    type HostReplyReason,
    hostResultText,
} from "./reply";
import { sessionOfThread, touchSession } from "./sessions";
import { withdrawPermissionAnswers, withdrawSend } from "./withdraw";

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

type ChunkRead = Pick<Doc<"persistentChunks">, "event" | "reasoning" | "seq" | "text">;

const appendChunks = (transcript: ReturnType<typeof emptyTranscript>, chunks: ChunkRead[]): void => {
    for (const chunk of chunks) {
        // Tool and permission events ride as `event` with no text of their own.
        if (chunk.text.length > 0 || chunk.reasoning) {
            // Past the cap the words are not kept; the paging goes on for the children and files that come after.
            if (!isTranscriptFull(transcript)) {
                appendToTranscript(transcript, chunk);
            }
        } else if (isChildEvent(chunk.event)) {
            appendChildEvent(transcript, chunk.event);
        }

        if (chunk.event?.kind === "media") {
            const { contentType, fileId, name, reference, size, storageKey } = chunk.event;

            addMediaToTranscript(transcript, {
                name,
                reference,
                size,
                ...(contentType !== undefined && { contentType }),
                ...(fileId !== undefined && { fileId }),
                ...(storageKey !== undefined && { storageKey }),
            });
        }
    }
};

/**
 * What the host wrote to a stream, in order, up to the reply cap. Pages through the chunks; once the text is full
 * only children and files are still collected (reasoning after that point is not kept), within the same page budget. When the page budget is spent first, the last pages are read
 * too and joined on after a marker, so the answer that follows a long run of tool events is not lost.
 */
export const readHostTranscript = async (ctx: Pick<QueryCtx, "db">, streamId: Id<"persistentStreams">) => {
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
        cursor = exhausted || pages >= MAX_TRANSCRIPT_PAGES ? undefined : (page.continueCursor ?? undefined);
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

        // The marker says the middle is missing, so it belongs wherever the tail adds text after a gap, even when the
        // front held only tool events; a tail with no text of its own has nothing for it to separate.
        if (!reachedFront && tail.some((chunk) => chunk.text.length > 0)) {
            appendToTranscript(transcript, { text: OMITTED_MARKER });
        }

        appendChunks(transcript, tail);
    }

    return transcript;
};

/**
 * Saves the reply through the agent write surface, so branches apply: a regenerate points the thread at the
 * prompt first and fails the earlier pending step, which makes the new reply the prompt's SIBLING
 * (the rule `saveLocalTurnHandler` follows). Returns what the agent said, whether or not there was a row to save.
 */
const saveHostReply = async (
    ctx: MutationCtx,
    stream: Stream,
    reason: HostReplyReason,
    error: string | undefined,
    changes: HostChanges | undefined,
): Promise<string> => {
    const threadId = stream.threadId as Id<"threads">;
    const thread = await ctx.db.get(threadId);
    // What the agent wrote is read first: the worker run waiting on this turn is told it, whether or not there is a row to save.
    const transcript = await readHostTranscript(ctx, stream._id);

    // The thread was deleted while the turn ran: a reply saved now would outlive its cleanup.
    if (!thread || thread.deleted) {
        return hostResultText(transcript, false);
    }

    // The prompt the reply answers is gone (a deleted message): saving would assert, and the reaper would
    // fail the whole shard tick on it.
    if (stream.messageId && !(await ctx.db.get(stream.messageId as Id<"messages">))) {
        return hostResultText(transcript, false);
    }

    const session = await sessionOfThread(ctx, threadId);
    const reply = buildHostReply({ agentKey: session?.agentKey ?? "host", changes, error, reason, transcript });

    if (!reply) {
        return hostResultText(transcript, false);
    }

    const promptMessageId = stream.messageId as Id<"messages">;
    const regenerate = stream.hostRegenerate === true;

    if (regenerate) {
        await patchThread(ctx.db, threadId, { activeLeafMessageId: promptMessageId });
    }

    await addMessagesHandler(ctx, { failPendingSteps: regenerate, messages: [reply], promptMessageId, threadId, userId: stream.userId });

    return hostResultText(transcript, true);
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

/** What a worker run is told when its host turn ends: the agent's words on success, the reason on a failure. */
const workerOutcomeOf = (reason: HostReplyReason, error: string | undefined, text: string): SubAgentOutcome => {
    if (reason === "finished") {
        return { kind: "succeeded", result: text };
    }

    if (reason === "cancelled" || reason === "stopped") {
        return { kind: "cancelled" };
    }

    const failures: Partial<Record<HostReplyReason, string>> = {
        interrupted: "The agent was cut off when the computer restarted.",
        revoked: "The computer was removed, so the agent stopped.",
        timeout: "The agent stopped reporting and the turn timed out.",
    };

    return { error: failures[reason] ?? (error?.trim() || "The agent stopped with an error."), kind: "failed" };
};

/**
 * A host turn ended: if a worker run sent it, that run ends with it, through the same `finishRun` a cloud run ends
 * through (so the lead gets the per-run post, a failure included, and the worker's next queued message starts).
 * A turn nobody dispatched finishes nothing. `functions.ts` is loaded only when a run is waiting, so the ingest
 * does not carry the sub-agent module on every turn, and the two modules do not import each other at load.
 */
export const settleWorkerRun = async (ctx: MutationCtx, stream: Stream, outcome: SubAgentOutcome): Promise<void> => {
    const run = await findRunningHostRun(ctx, stream);

    if (!run) {
        return;
    }

    const { finishRun } = await import("../../sub-agents/functions");

    await finishRun(ctx, run._id, outcome);
};

/**
 * Saves the reply and ends the stream, whoever ends it. A stream that already ended is left alone (false). The
 * session goes idle only when the caller says so (`idle`: a turn's end), not for a revoke, which has ended it. A worker run
 * that sent the turn ends after that, so the line it holds can start the next message on a session that is free.
 */
export const endHostTurn = async (
    ctx: MutationCtx,
    stream: Stream,
    end: { changes?: HostChanges; error?: string; idle?: boolean; reason: HostReplyReason },
    now: number,
): Promise<boolean> => {
    if (!isLiveStream(stream)) {
        return false;
    }

    const text = await saveHostReply(ctx, stream, end.reason, end.error, end.changes);

    await withdrawPermissionAnswers(ctx, stream, now);

    if (!(await endHostStream(ctx, stream, { reason: end.reason, status: STATUS_OF[end.reason] }, now))) {
        return false;
    }

    // A pull request's guide written by this turn is finished, or failed, by how the turn ended.
    await settleHostGuide(ctx, stream, end.reason);

    if (end.idle) {
        const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

        if (session) {
            await touchSession(ctx, session, "idle", now);
        }
    }

    await settleWorkerRun(ctx, stream, workerOutcomeOf(end.reason, end.error, text));

    return true;
};

/** The host's `turn_end` or Stop: {@link endHostTurn}, then the session is free again. */
export const finishHostTurn = async (
    ctx: MutationCtx,
    stream: Stream,
    end: { changes?: HostChanges; error?: string; reason: HostReplyReason },
    now: number,
): Promise<boolean> => await endHostTurn(ctx, stream, { ...end, idle: true }, now);

/** Live host streams read per pass by {@link endLiveHostTurns}. A thread runs one turn at a time, so a pass is rarely more than one. */
export const LIVE_STREAM_BATCH = 50;

/**
 * Ends every live host stream of a thread through {@link endHostTurn}, each saving its reply. Read in bounded
 * passes: a stream that ended is no longer live, so the next pass starts from the front and finds the rest.
 */
export const endLiveHostTurns = async (
    ctx: MutationCtx,
    threadId: Id<"threads">,
    end: { error?: string; reason: HostReplyReason },
    now: number,
): Promise<void> => {
    for (;;) {
        const { page: live } = await ctx.db.persistentStreams.findMany({
            limit: LIVE_STREAM_BATCH,
            where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId },
        });
        let ended = 0;

        for (const stream of live) {
            if (await endHostTurn(ctx, stream, end, now)) {
                ended += 1;
            }
        }

        if (live.length < LIVE_STREAM_BATCH || ended === 0) {
            return;
        }
    }
};

/**
 * Asks the stream's host to stop the turn. Best effort: a refusal (budget, device gone) leaves the stream ended all the same.
 * The computer drops the prompts queued behind the turn unless `keepQueue`. A worker's thread always keeps them: only the
 * worker's own messages queue there (`/hosts/send` refuses its thread), and ending the stopped turn signs the next one's
 * `acp_send` in the same transaction, which the computer may apply before this cancel.
 */
export const sendHostCancel = async (ctx: MutationCtx, stream: Stream, now: number, keepQueue = false): Promise<void> => {
    if (!stream.hostTurnId) {
        return;
    }

    const keep = keepQueue || (await isWorkerThread(ctx, stream.threadId));

    const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

    if (!session || session.status === "ended") {
        return;
    }

    try {
        const result = await createAcpCancelCall(
            ctx,
            {
                deviceId: session.deviceId,
                hostSessionId: session.hostSessionId,
                keepQueue: keep,
                threadId: stream.threadId as Id<"threads">,
                turnId: stream.hostTurnId,
                userId: stream.userId,
            },
            now,
        );

        // A refusal is an answer, not a throw: the device already holds its whole budget of open calls (`busy`) or is
        // gone (`ineligible`). The stream ends all the same, and the host stops the turn when its own cap or restart does.
        if ("error" in result) {
            streamLogger.warn(`[acp] could not ask the host to cancel a turn: ${result.error}`);
        }
    } catch (error) {
        // Best effort, as above: the stream ends either way.
        streamLogger.warn("[acp] could not ask the host to cancel a turn", error);
    }
};

/** The sidebar's Stop for a host stream: keep what was written, end the stream, tell the host to cancel. */
export const stopHostTurn = async (ctx: MutationCtx, stream: Stream, now: number, keepQueue = false): Promise<void> => {
    if (!isLiveStream(stream)) {
        return;
    }

    // A prompt the computer has not acknowledged is withdrawn, so a Stop before the computer took it means it never runs.
    if (stream.hostState === "accepted") {
        await withdrawSend(ctx, stream, now);
    }

    // The cancel is signed BEFORE the turn ends: ending it can start the worker's next queued message, whose send must
    // follow the cancel, not reach the computer while it is still running the turn that was stopped.
    await sendHostCancel(ctx, stream, now, keepQueue);
    await finishHostTurn(ctx, stream, { reason: "stopped" }, now);
};

/**
 * Ends a live host turn from the Neore side, for a worker run that was stopped or failed while its turn ran: a prompt the
 * computer has not acknowledged is withdrawn so it cannot start later, what the agent wrote is kept, and the computer is told to cancel.
 */
export const cancelHostTurnNow = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    // What waits on the computer behind this turn is other runs' messages, so the cancel leaves it queued.
    await stopHostTurn(ctx, stream, now, true);
};
