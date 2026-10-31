/**
 * A worker run on a paired computer's coding agent (plans/agent-orchestrator.md S5): the dispatch as the existing
 * `acp_send` call, and the reads that tie a run to its host turn. Light on purpose: the `acp` module reads these from
 * the turn's end, and `functions.ts` (which finishes runs) is loaded from there only when a run is actually waiting.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { queueHostTurn } from "../acp/lib/send-turn";
import { sessionOfThread } from "../acp/lib/sessions";
import { isLiveStream } from "../chat/streaming/persistent/host";
import { buildSubAgentPrompt } from "./logic";

type RunDoc = Doc<"subAgentRuns">;

/** What a worker run is sent to the agent as: the person's own words as written, a lead's task framed as a delegation. */
const promptOf = (run: Pick<RunDoc, "clientId" | "task">): string => (run.clientId === undefined ? buildSubAgentPrompt(run.task) : run.task);

const REFUSALS = {
    busy: "That computer is busy. Try again in a moment.",
    ineligible: "That computer is no longer paired.",
    input_too_large: "The message is too long to send to the agent.",
    offline: "The host did not answer: that computer is offline.",
} as const;

/**
 * Sends a claimed run's message to the worker's agent: the same signed `acp_send` as a message from the web
 * (`queueHostTurn`), under a turn id the run keeps, so that turn's end finishes this run and no other. Answers why
 * nothing was sent, for the caller to fail the run with; the turn is not retried or held back for a host that is not answering.
 */
export const sendHostRunTurn = async (ctx: MutationCtx, run: RunDoc, now: number): Promise<{ error: string } | { turnId: string }> => {
    const session = run.childThreadId === undefined ? null : await sessionOfThread(ctx, run.childThreadId as Id<"threads">);

    if (!session || session.status === "ended") {
        return { error: "The agent's session has ended. Start a new worker to continue." };
    }

    // The session runs one turn at a time. A turn the person started in the desktop window holds it.
    const busy = await ctx.db.persistentStreams.findFirst({
        where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId: session.threadId },
    });

    if (busy) {
        return { error: "The agent is busy with another turn on that computer." };
    }

    const queued = await queueHostTurn(ctx, { session, text: promptOf(run), threadId: session.threadId, userId: run.userId }, now);

    if ("error" in queued) {
        return { error: REFUSALS[queued.error] };
    }

    await ctx.db.patch(run._id, { hostTurnId: queued.turnId, updatedAt: now });

    return { turnId: queued.turnId };
};

/** The running host run that sent this stream's turn, or null: a turn nobody dispatched belongs to no run. */
export const findRunningHostRun = async (
    ctx: Pick<MutationCtx, "db">,
    stream: Pick<Doc<"persistentStreams">, "hostTurnId" | "threadId">,
): Promise<RunDoc | null> => {
    if (stream.hostTurnId === undefined) {
        return null;
    }

    const running = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId_and_status", (q) => q.eq("childThreadId", stream.threadId).eq("status", "running"))
        .take(5);

    return running.find((run) => run.runner?.kind === "host" && run.hostTurnId === stream.hostTurnId) ?? null;
};

/**
 * A host run's activity: when its host last wrote an event, and whether the agent is waiting on a person's answer to a
 * permission request. The worker's thread shows no new message while a turn streams (the reply is saved at its end),
 * so the stream's own events are the clock. While it waits on a person it is not stuck, and neither the quiet notice
 * nor the stale clock runs.
 *
 * `chunk` reads the newest event, for the reaper. A live query reads `session`, the session's own clock, which moves at
 * most every `SESSION_TOUCH_MS`: every post writes a chunk, and a view reading it would re-run for every viewer
 * several times a second.
 */
export const hostRunActivity = async (
    ctx: Pick<QueryCtx, "db">,
    run: Pick<RunDoc, "childThreadId" | "hostTurnId">,
    precision: "chunk" | "session",
): Promise<{ at: number | undefined; waitingOnPerson: boolean }> => {
    const stream = run.hostTurnId === undefined ? null : await ctx.db.persistentStreams.findFirst({ where: { hostTurnId: run.hostTurnId } });

    if (!stream) {
        return { at: undefined, waitingOnPerson: false };
    }

    const waitingOnPerson = isLiveStream(stream) && (stream.hostPendingPermissions?.length ?? 0) > 0;

    if (precision === "session") {
        const session = await ctx.db.acpSessions.findFirst({ where: { threadId: stream.threadId as Id<"threads"> } });

        return { at: session?.lastEventAt, waitingOnPerson };
    }

    const newest = await ctx.db.persistentChunks.findFirst({ orderBy: [{ seq: "desc" }], where: { streamId: stream._id } });

    return { at: newest?._creationTime, waitingOnPerson };
};
