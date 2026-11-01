/**
 * The write surface other modules use to drop a thread's pull request links (`pullRequestThreads` belongs to
 * `source-control`). A plain function over `ctx.db`, so it runs in the caller's transaction.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Removes every link a thread has, attached or opened. `userId` is the thread owner's (optional on the row). */
export const deletePullRequestLinksOfThread = async (ctx: Pick<MutationCtx, "db">, userId: string | undefined, threadId: Id<"threads">): Promise<void> => {
    if (userId === undefined) {
        return;
    }

    const links = await ctx.db
        .query("pullRequestThreads")
        .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
        .collect();

    for (const link of links) {
        await ctx.db.delete(link._id);
    }
};
