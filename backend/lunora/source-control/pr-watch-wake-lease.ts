/**
 * Whether a pull request watch's wake turn holds a thread (`pr-watch-wake.ts`): a claimed delivery keeps `watchWakeLeaseUntil` on the
 * link from its claim until the turn ends. Kept apart from the wake itself so the thread lock (`agent/thread-lock.ts`) can read it
 * without loading the agent run.
 *
 * The lock refuses while a lease on one of the thread's links is held, and the job's last check before the model (`beginWatchWake`)
 * refuses a locked thread in the same transaction that charges the round: either the lock commits first and no turn starts, or the
 * turn is already claimed and the lock waits, the way a title or follow-up model request is dispatched (`agent/thread-title.ts`).
 * The same lease keeps a second claim off a thread another watch's turn is running in.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Links of one thread read for a held lease: a thread holds a handful of pull request links, so this is far past any real one. */
const LINKS_READ = 100;

/** The ids of the thread's links whose wake lease is held at `now`, other than `exceptLinkId`. */
export const heldWakeLeases = async (
    ctx: Pick<QueryCtx, "db">,
    userId: string,
    threadId: Id<"threads">,
    now: number,
    exceptLinkId?: Id<"pullRequestThreads">,
): Promise<Id<"pullRequestThreads">[]> => {
    const links = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(LINKS_READ);

    return links
        .filter((link) => link._id !== exceptLinkId && link.watchWakeLeaseUntil !== undefined && link.watchWakeLeaseUntil > now)
        .map((link) => link._id);
};
