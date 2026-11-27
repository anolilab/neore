/**
 * Whether a pull request watch's wake turn holds a thread (`pr-watch-wake.ts`): a claimed delivery keeps `watchWakeLeaseUntil` on the
 * link from its claim until the turn ends. Kept apart from the wake itself so the thread lock (`agent/thread-lock.ts`) can read it
 * without loading the agent run.
 *
 * The lock refuses while a lease on one of the thread's links is held, and the job's last check before the model (`beginWatchWake`)
 * refuses a locked thread in the same transaction that charges the round: either the lock commits first and no turn starts, or the
 * turn is already claimed and the lock waits, the way a title or follow-up model request is dispatched (`agent/thread-title.ts`).
 * The same lease keeps a second claim off a thread another watch's turn is running in. Only the links with a live lease are read
 * (`wakeLeaseHeld`), so a thread with many links neither hides a held lease nor is blocked without one.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { v } from "lunorash/server";

/**
 * Whether a wake lease is held on a link of the thread at `now`, other than `exceptLinkId`. Only the links whose lease time is later
 * than `now` are read (an index on the thread and the lease time), so the answer depends on the live leases and not on how many links the
 * thread has: none live is `false`, however many links there are, and a live lease on any link of the thread is always found. Two rows
 * are enough to see past the excepted link. A read that fails throws, and the caller's lock, delete or claim does not go ahead.
 */
export const wakeLeaseHeld = async (
    ctx: Pick<QueryCtx, "db">,
    userId: string,
    threadId: Id<"threads">,
    now: number,
    exceptLinkId?: Id<"pullRequestThreads">,
): Promise<boolean> => {
    const live = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_thread_and_wakeLease", (q) => q.eq("userId", userId).eq("threadId", threadId).gt("watchWakeLeaseUntil", now))
        .take(2);

    return live.some((link) => link._id !== exceptLinkId);
};

/** Whether a wake lease is held on the thread now: asked by a reply before it writes anything, so the reply waits (`chat/http.ts`). */
export const wakeLeaseHeldFor = internalQuery
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.boolean())
    .query(async ({ args, ctx }) => await wakeLeaseHeld(ctx, args.userId, args.threadId, ctx.now));
