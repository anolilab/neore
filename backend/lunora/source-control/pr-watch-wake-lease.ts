/**
 * Whether a pull request watch's wake turn holds a thread (`pr-watch-wake.ts`): a claimed delivery keeps `watchWakeLeaseUntil` on the
 * link from its claim until the turn ends. Kept apart from the wake itself so the thread lock (`agent/thread-lock.ts`) can read it
 * without loading the agent run.
 *
 * The lock refuses while a lease on one of the thread's links is held, and the job's last check before the model (`beginWatchWake`)
 * refuses a locked thread in the same transaction that charges the round: either the lock commits first and no turn starts, or the
 * turn is already claimed and the lock waits, the way a title or follow-up model request is dispatched (`agent/thread-title.ts`).
 * The same lease keeps a second claim off a thread another watch's turn is running in. Every link of the thread is read (`wakeLeaseHeld`),
 * so a thread with many links cannot hide a held lease.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Links read per page, and pages per scan: 5000 links of one thread, far past any real one. */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Whether a wake lease is held on a link of the thread at `now`, other than `exceptLinkId`: every link of the thread is read, page by
 * page, and the scan stops at the first held lease. A thread with more links than the bound allows cannot be cleared, so a scan that
 * cannot finish fails CLOSED: the thread counts as busy, and the lock, the delete or the claim is refused.
 */
export const wakeLeaseHeld = async (
    ctx: Pick<QueryCtx, "db">,
    userId: string,
    threadId: Id<"threads">,
    now: number,
    exceptLinkId?: Id<"pullRequestThreads">,
): Promise<boolean> => {
    let cursor: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
        const read = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
            .paginate({ cursor, numItems: PAGE_SIZE });

        if (read.page.some((link) => link._id !== exceptLinkId && link.watchWakeLeaseUntil !== undefined && link.watchWakeLeaseUntil > now)) {
            return true;
        }

        if (read.isDone) {
            return false;
        }

        cursor = read.continueCursor;
    }

    return true;
};
