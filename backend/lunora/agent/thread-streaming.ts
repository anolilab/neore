import type { MutationCtx } from "../_generated/server";

/** Streams of one thread checked for activity — its latest few, never its history. */
const RECENT_STREAMS_CHECKED = 5;

/** Whether the thread has a run still writing to it (`persistentStreams`, pending or streaming). */
export const isThreadStreaming = async (ctx: Pick<MutationCtx, "db">, threadId: string): Promise<boolean> => {
    const streams = await ctx.db
        .query("persistentStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .take(RECENT_STREAMS_CHECKED);

    return streams.some((stream) => stream.status === "pending" || stream.status === "streaming");
};
