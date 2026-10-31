/** "Time reached": a single moment. It fires once; the scheduler disarms the watcher afterwards. */
import type { EventSource } from "./types";

export const timeSource: EventSource<{ at: number; kind: "time" }> = {
    check: async (ctx, config, state) => {
        if (ctx.now < config.at) {
            return { fired: false, state };
        }

        return {
            fired: true,
            fireKey: `at:${String(config.at)}`,
            state,
            summary: `The time has come: ${new Date(config.at).toISOString()}`,
        };
    },
};
