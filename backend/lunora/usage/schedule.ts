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
import { currentUserShard, servesUser } from "../lib/shard-context";
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
    let scheduled: Promise<unknown>;

    if (usageArgs.threadId === undefined) {
        // No thread to read: to the user's shard, named unless this job runs there — an action has no shard of its own.
        scheduled =
            currentUserShard() === usageArgs.userId
                ? scheduler.runAfter(0, target as never, usageArgs as never)
                : runAfterOnShard(scheduler, 0, target, { ...usageArgs }, usageArgs.userId);
    } else if (servesUser(usageArgs.userId)) {
        scheduled = scheduler.runAfter(0, target as never, usageArgs as never);
    } else {
        // Another user's thread: its project is read here, on its shard, then forwarded.
        scheduled = scheduler.runAfter(0, internal.usage.activity.forwardReplyUsage as never, { ...usageArgs, threadId: usageArgs.threadId } as never);
    }

    void scheduled.catch((error: unknown) => {
        streamLogger.warn("[usage] rollup record not scheduled", error);
    });
};
