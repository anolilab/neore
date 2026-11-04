import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Far above the links one thread holds: the read is bounded, so a thread with more is marked up to this many. */
const MAX_LINKS_OF_THREAD = 200;

/**
 * Marks every link of a thread with whether the thread is deleted. The sidebar count reads link rows only, so the thread's delete and
 * restore keep these rows in step. Called from the thread's soft delete and restore, in the same transaction.
 */
export const setLinksThreadDeleted = async (ctx: MutationCtx, userId: string | undefined, threadId: Id<"threads">, deleted: boolean): Promise<void> => {
    // A thread with no owner holds no links: links are written under their owner's user.
    if (userId === undefined) {
        return;
    }

    const links = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .take(MAX_LINKS_OF_THREAD);

    for (const link of links) {
        await ctx.db.patch("pullRequestThreads", link._id, { threadDeleted: deleted });
    }
};
