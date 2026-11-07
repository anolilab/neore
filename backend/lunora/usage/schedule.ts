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
import { RECORD_RETRY } from "./activity-logic";

interface SchedulerLike {
    runAfter: (delayMs: number, target: never, args: never) => Promise<unknown>;
}

export const scheduleReplyUsage = (scheduler: SchedulerLike, usageArgs: ReplyUsageArgs | undefined): void => {
    if (!usageArgs) {
        return;
    }

    const target = internal.usage.activity.recordReplyUsage;
    let scheduled: Promise<unknown>;

    // A job that reads the thread's project fails when that read fails, and is retried (`RECORD_RETRY`); its last try
    // records the reply without a project, so one failed read never loses the reply's total.
    if (servesUser(usageArgs.userId)) {
        scheduled = runAfterWithRetry(scheduler, 0, target, { ...usageArgs }, RECORD_RETRY);
    } else if (usageArgs.threadId === undefined || usageArgs.threadAttribution !== undefined) {
        // No thread to read, or the caller already read it: straight to the user's shard.
        scheduled = runAfterOnShard(scheduler, 0, target, { ...usageArgs }, usageArgs.userId);
    } else {
        // Another user's thread: its project is read here, on its shard, then forwarded.
        scheduled = runAfterWithRetry(scheduler, 0, internal.usage.activity.forwardReplyUsage, { ...usageArgs, threadId: usageArgs.threadId }, RECORD_RETRY);
    }

    void scheduled.catch((error: unknown) => {
        streamLogger.warn("[usage] rollup record not scheduled", error);
    });
};
