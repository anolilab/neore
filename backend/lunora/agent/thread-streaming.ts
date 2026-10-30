import type { MutationCtx } from "../_generated/server";

/** Streams of one thread checked for activity — its latest few, never its history. */
const RECENT_STREAMS_CHECKED = 5;

const recentStreams = async (ctx: Pick<MutationCtx, "db">, threadId: string) =>
    await ctx.db
        .query("persistentStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .take(RECENT_STREAMS_CHECKED);

/** Whether the thread has a run still writing to it (`persistentStreams`, pending or streaming). */
export const isThreadStreaming = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<boolean> => {
    const streams = await recentStreams(ctx, threadId);

    return streams.some((stream) => stream.status === "pending" || stream.status === "streaming");
};

/**
 * Whether a reply is still streaming into the thread through the delta stream (`streamingMessages`), which the
 * edit reply uses instead of `persistentStreams`. A stuck row is aborted by its own timeout, so this cannot block for good.
 */
export const hasLiveDeltaStream = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<boolean> => {
    const live = await ctx.db
        .query("streamingMessages")
        .withIndex("threadId_state_order_stepOrder", (q) => q.eq("threadId", threadId as never).eq("stateKind", "streaming"))
        .take(1);

    return live.length > 0;
};

/** Whether a run was ever started for `messageId` (a prompt), in any state — a run stopped before its first token counts. */
export const hasStreamFor = async (ctx: Pick<MutationCtx, "db">, threadId: string, messageId: string): Promise<boolean> => {
    const streams = await recentStreams(ctx, threadId);

    return streams.some((stream) => stream.messageId === messageId);
};

/**
 * Whether a sidebar stop has ended a run whose owed text is not saved yet: the stream is `done` (`stopActiveForThread`)
 * but `finishStoppedReply` has not cleared `stoppedAt`, so the reply would still land under its prompt. A run that dies
 * without ever saving it stops counting at the stream's `expiresAt`, which the timeout cron does not touch for a `done` stream.
 */
export const hasUnsettledStop = async (ctx: Pick<MutationCtx, "db">, threadId: string, now: number): Promise<boolean> => {
    const streams = await recentStreams(ctx, threadId);

    return streams.some((stream) => stream.stoppedAt !== undefined && stream.expiresAt > now);
};
