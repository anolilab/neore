import type { QueryCtx } from "../_generated/server";

/** Whether `threadId` is a worker's thread — a turn there runs only through a dispatch. Light on purpose: the host-send path reads it. */
export const isWorkerThread = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<boolean> => {
    const first = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", threadId))
        .first();

    return first?.mode === "worker";
};

/** The lead thread `threadId` was started from, when it is a sub-agent's or worker's thread. */
export const leadThreadOf = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<string | undefined> => {
    const run = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", threadId))
        .first();

    return run?.parentThreadId;
};
