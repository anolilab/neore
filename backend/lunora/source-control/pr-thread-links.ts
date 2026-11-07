/**
 * The write surface other modules use for a thread's pull request links (`pullRequestThreads` belongs to
 * `source-control`): the thread's soft delete and restore mark them, and its hard delete removes them. Plain functions
 * over `ctx.db`, so they run in the caller's transaction, and both walk the thread's links the same way, page by page.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Link rows read per page; every page is read, so no link of the thread is left out. */
const LINK_PAGE_SIZE = 100;

/** Runs `visit` on every link of the thread. `userId` is the thread owner's (optional on the row): a thread with none holds no links. */
const eachLinkOfThread = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string | undefined,
    threadId: Id<"threads">,
    visit: (link: Doc<"pullRequestThreads">) => Promise<void>,
): Promise<void> => {
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
            await visit(link);
        }

        if (page.isDone) {
            return;
        }

        cursor = page.continueCursor;
    }
};

/** Marks every link of a thread with whether the thread is deleted: called from the thread's soft delete and restore. */
export const setLinksThreadDeleted = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string | undefined,
    threadId: Id<"threads">,
    deleted: boolean,
): Promise<void> => {
    await eachLinkOfThread(ctx, userId, threadId, async (link) => {
        await ctx.db.patch("pullRequestThreads", link._id, { threadDeleted: deleted });
    });
};

/** Removes every link a thread has, attached or opened: called from the thread's hard delete. */
export const deletePullRequestLinksOfThread = async (ctx: Pick<MutationCtx, "db">, userId: string | undefined, threadId: Id<"threads">): Promise<void> => {
    await eachLinkOfThread(ctx, userId, threadId, async (link) => {
        await ctx.db.delete("pullRequestThreads", link._id);
    });
};
