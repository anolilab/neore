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

/** Whether a run was ever started for `messageId` (a prompt), in any state — a run stopped before its first token counts. */
export const hasStreamFor = async (ctx: Pick<MutationCtx, "db">, threadId: string, messageId: string): Promise<boolean> => {
    const streams = await recentStreams(ctx, threadId);

    return streams.some((stream) => stream.messageId === messageId);
};
