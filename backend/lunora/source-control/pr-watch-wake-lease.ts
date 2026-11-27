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
import { LunoraError, v } from "lunorash/server";

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

/**
 * Whether a wake lease is held on the thread now: asked by a reply before it writes anything, so the reply waits (`chat/http.ts`). It keys
 * on the THREAD: the lease sits on the owner's link, so it is looked up under the thread's owner, whoever is replying (a collaborator
 * included), as the lock and the delete do.
 */
export const wakeLeaseHeldFor = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId);

        return thread?.userId !== undefined && (await wakeLeaseHeld(ctx, thread.userId, args.threadId, ctx.now));
    });

/**
 * Refuses, before anything is written, a change that would make a chat shared (a new grant, public visibility, a group chat) while a
 * wake turn holds it: the wake publishes pull request text in the chat, which a reader added now could see. The same held-lease check the
 * lock, the delete and the reply use.
 */
export const refuseWhileWaking = async (ctx: Pick<QueryCtx, "db"> & { now: number }, userId: string, threadId: Id<"threads">): Promise<void> => {
    if (await wakeLeaseHeld(ctx, userId, threadId, ctx.now)) {
        throw new LunoraError("CONFLICT", "A pull request watch is writing to this chat. Try again in a moment.");
    }
};
