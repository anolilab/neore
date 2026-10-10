/**
 * Hands a finished run's usage to `usage_activity.recordReplyUsage`. Every run
 * path goes through here — interactive and group replies (`afterRun`), headless
 * runs (`runHeadlessAgent`) and the Daily Brief — so they route and key the
 * record the same way.
 *
 * The rollup is the USER's: a turn in a thread someone shared runs on the
 * owner's shard, and its record goes to the user's own. Best-effort — a record
 * that could not be scheduled is logged, never raised into the run.
 */
import { internal } from "../_generated/internal";
import { streamLogger } from "../lib/logger";
import { servesUser } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import type { ReplyUsageArgs } from "./activity-logic";

interface SchedulerLike {
    runAfter: (delayMs: number, target: never, args: never) => Promise<unknown>;
}

export const scheduleReplyUsage = (scheduler: SchedulerLike, usageArgs: ReplyUsageArgs | undefined): void => {
    if (!usageArgs) {
        return;
    }

    const target = internal.usage.activity.recordReplyUsage;
    const scheduled: Promise<unknown> = servesUser(usageArgs.userId)
        ? scheduler.runAfter(0, target as never, usageArgs as never)
        : runAfterOnShard(scheduler, 0, target, { ...usageArgs }, usageArgs.userId);

    void scheduled.catch((error: unknown) => {
        streamLogger.warn("[usage] rollup record not scheduled", error);
    });
};
