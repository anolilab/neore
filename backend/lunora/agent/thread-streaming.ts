import type { QueryCtx } from "../_generated/server";

/** Streams of one thread checked for activity — its latest few, never its history. */
const RECENT_STREAMS_CHECKED = 5;

const recentStreams = async (ctx: Pick<QueryCtx, "db">, threadId: string) =>
    await ctx.db
        .query("persistentStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .take(RECENT_STREAMS_CHECKED);

/**
 * Whether the thread has a run still writing to it (`persistentStreams`, pending or streaming). Read by status, not
 * from the newest streams: a send does not wait for a live run, so newer runs can finish while an older one streams.
 */
export const isThreadStreaming = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<boolean> => {
    for (const status of ["pending", "streaming"]) {
        const live = await ctx.db
            .query("persistentStreams")
            .withIndex("by_threadId_status", (q) => q.eq("threadId", threadId).eq("status", status))
            .take(1);

        if (live.length > 0) {
            return true;
        }
    }

    return false;
};

/**
 * Whether a reply is still streaming into the thread through the delta stream (`streamingMessages`), which the
 * edit reply uses instead of `persistentStreams`. A stuck row is aborted by its own timeout, so this cannot block for good.
 */
export const hasLiveDeltaStream = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<boolean> => {
    const live = await ctx.db
        .query("streamingMessages")
        .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", threadId as never).eq("stateKind", "streaming"))
        .take(1);

    return live.length > 0;
};

/** Whether a run was ever started for `messageId` (a prompt), in any state — a run stopped before its first token counts. */
export const hasStreamFor = async (ctx: Pick<QueryCtx, "db">, threadId: string, messageId: string): Promise<boolean> => {
    // Any stream of that prompt, however many later runs the thread had: an older prompt can become the displayed
    // leaf (a branch switch). One indexed read, so a busy thread's retained streams are never loaded.
    const stream = await ctx.db
        .query("persistentStreams")
        .withIndex("by_threadId_messageId", (q) => q.eq("threadId", threadId).eq("messageId", messageId))
        .first();

    return stream !== null;
};

/**
 * How long after a sidebar stop its run is expected to have saved the text it owed. The run learns of the stop at its
 * next chunk write or its stop poll (`STOP_POLL_MS`, 2 s), then saves in one mutation; a tool that ignores the abort
 * signal can hold it longer. Past this a run that died is not waited for, whatever its stream's `expiresAt` says.
 */
const STOPPED_RUN_SETTLE_MS = 2 * 60 * 1000;

/**
 * Whether a sidebar stop has ended a run whose owed text is not saved yet: the stream is `done` (`stopActiveForThread`)
 * but `finishStoppedReply` has not cleared `stoppedAt`, so the reply would still land under its prompt. A run that fails
 * clears it (`settleStoppedRun`); one that dies without a trace stops counting after {@link STOPPED_RUN_SETTLE_MS}.
 */
export const hasUnsettledStop = async (ctx: Pick<QueryCtx, "db">, threadId: string, now: number): Promise<boolean> => {
    const streams = await recentStreams(ctx, threadId);

    return streams.some((stream) => stream.stoppedAt !== undefined && stream.stoppedAt > now - STOPPED_RUN_SETTLE_MS);
};
