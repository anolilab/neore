/**
 * "Thread replied": a new message lands in a chosen thread the owner can read, from a sub-agent, a
 * model or another person (the owner's own messages do not count). The thread may live on another
 * user's shard, so the scan is a port (`ctx.scanThread`); this source only keeps the baseline.
 */
import type { EventSource } from "./types";

export const threadSource: EventSource<{ kind: "thread"; threadId: string }> = {
    check: async (ctx, config, state) => {
        const after = state.lastOrder === undefined ? undefined : { order: state.lastOrder, stepOrder: state.lastStepOrder ?? -1 };
        const scan = await ctx.scanThread(config.threadId, after);
        // An empty thread has no row to point at: -1 sorts before every real one.
        const next = {
            ...state,
            lastOrder: scan.baseline?.order ?? state.lastOrder ?? -1,
            lastStepOrder: scan.baseline?.stepOrder ?? state.lastStepOrder ?? -1,
        };

        // First look: the thread as it is now is the baseline.
        if (after === undefined || !scan.reply) {
            return { fired: false, state: next };
        }

        return {
            excerpt: scan.reply.text,
            fired: true,
            fireKey: `reply:${scan.reply.id}`,
            state: next,
            summary: `A reply landed in thread ${config.threadId}.`,
        };
    },
};
