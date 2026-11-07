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
import { runAfterOnShard, runAfterWithRetry } from "../lib/shard-scheduler";
import type { ReplyUsageArgs } from "./activity-logic";
import { RECORD_FALLBACK_MS, RECORD_RETRY } from "./activity-logic";

interface SchedulerLike {
    runAfter: (delayMs: number, target: never, args: never) => Promise<unknown>;
}

export const scheduleReplyUsage = (scheduler: SchedulerLike, usageArgs: ReplyUsageArgs | undefined): void => {
    if (!usageArgs) {
        return;
    }

    const target = internal.usage.activity.recordReplyUsage;
    let scheduled: Promise<unknown>;

    // A job that reads the thread's project fails when that read fails, and is retried (`RECORD_RETRY`).
    if (servesUser(usageArgs.userId)) {
        // Only a record that reads a project fails fast on a failed read; any other keeps the scheduler's default retries.
        scheduled =
            usageArgs.threadId === undefined
                ? scheduler.runAfter(0, target as never, usageArgs as never)
                : runAfterWithRetry(scheduler, 0, target, { ...usageArgs }, RECORD_RETRY);
    } else if (usageArgs.threadId === undefined || usageArgs.threadAttribution !== undefined) {
        // No thread to read, or the caller already read it: straight to the user's shard.
        scheduled = runAfterOnShard(scheduler, 0, target, { ...usageArgs }, usageArgs.userId);
    } else {
        // Another user's thread: its project is read here, on its shard, then forwarded.
        scheduled = runAfterWithRetry(scheduler, 0, internal.usage.activity.forwardReplyUsage, { ...usageArgs, threadId: usageArgs.threadId }, RECORD_RETRY);
    }

    // A record that reads a project can fail every try: its fallback, well after the last one, lands the reply's total
    // and skill rows without a project. The reply's key makes it add nothing when the record landed.
    if (usageArgs.threadId !== undefined) {
        const fallback = runAfterOnShard(scheduler, RECORD_FALLBACK_MS, target, { ...usageArgs, fallback: true, threadAttribution: {} }, usageArgs.userId);

        void fallback.catch((error: unknown) => {
            streamLogger.warn("[usage] fallback record not scheduled", error);
        });
    }

    void scheduled.catch((error: unknown) => {
        streamLogger.warn("[usage] rollup record not scheduled", error);
    });
};
