import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Link rows read per page; every page is read, so no link of the thread is left unmarked. */
const LINK_PAGE_SIZE = 100;

/**
 * Marks every link of a thread with whether the thread is deleted. The sidebar count reads link rows only, so the thread's delete and
 * restore keep these rows in step. Called from the thread's soft delete and restore, in the same transaction.
 */
export const setLinksThreadDeleted = async (ctx: MutationCtx, userId: string | undefined, threadId: Id<"threads">, deleted: boolean): Promise<void> => {
    // A thread with no owner holds no links: links are written under their owner's user.
    if (userId === undefined) {
        return;
    }

    // Agent-opened links have no per-thread cap, so the rows are paged to the end rather than read up to a bound.
    let cursor: string | null = null;

    for (;;) {
        const page = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
            .paginate({ cursor, numItems: LINK_PAGE_SIZE });

        for (const link of page.page) {
            await ctx.db.patch("pullRequestThreads", link._id, { threadDeleted: deleted });
        }

        if (page.isDone) {
            return;
        }

        cursor = page.continueCursor;
    }
};
