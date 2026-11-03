import type { QueryCtx } from "../_generated/server";

/** Whether `threadId` is a worker's thread — a turn there runs only through a dispatch. Light on purpose: the host-send path reads it. */
export const isWorkerThread = async (ctx: Pick<QueryCtx, "db">, threadId: string): Promise<boolean> => {
    const first = await ctx.db
        .query("subAgentRuns")
        .withIndex("by_childThreadId", (q) => q.eq("childThreadId", threadId))
        .first();

    return first?.mode === "worker";
};
