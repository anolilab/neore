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

/**
 * Every link row of one pull request on the user's shard, paged to the end. Links to deleted threads stay as rows, so a
 * bounded read could fill with them and hide a link made later; a merge must reach every link of the pull request.
 */
export const pullRequestLinksOf = async (ctx: Pick<MutationCtx, "db">, userId: string, repo: string, number: number): Promise<Doc<"pullRequestThreads">[]> => {
    const rows: Doc<"pullRequestThreads">[] = [];
    let cursor: string | null = null;

    for (;;) {
        const page = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_repository_number", (q) => q.eq("userId", userId).eq("repository", repo).eq("number", number))
            .paginate({ cursor, numItems: LINK_PAGE_SIZE });

        rows.push(...page.page);

        if (page.isDone) {
            return rows;
        }

        cursor = page.continueCursor;
    }
};

/**
 * Marks a link's archive attempt for its merge as final: the chat was archived, or a guard or the setting declined it. The
 * archive calls this in the same transaction as the attempt, so a retry can never run after the chat was reopened.
 */
export const settleMergedLinkRow = async (ctx: Pick<MutationCtx, "db">, linkId: Id<"pullRequestThreads">, at: number): Promise<void> => {
    const link = await ctx.db.get("pullRequestThreads", linkId);

    if (link && link.mergeSettledAt === undefined) {
        await ctx.db.patch("pullRequestThreads", linkId, { mergeSettledAt: at });
    }
};

/** Records that an archive attempt for the owed link found its chat busy, so the next read reaches the other owed links first. */
export const noteMergeAttemptRow = async (ctx: Pick<MutationCtx, "db">, linkId: Id<"pullRequestThreads">, at: number): Promise<void> => {
    const link = await ctx.db.get("pullRequestThreads", linkId);

    if (link && link.mergeSettledAt === undefined) {
        await ctx.db.patch("pullRequestThreads", linkId, { mergeAttemptedAt: at });
    }
};

/**
 * Settles every owed merge link of the chat, whichever pull request it names. Every archive of the chat calls this (`markThreadArchived`),
 * so reopening an archived chat cannot archive it again for a merge it already covered. Read over the chat's own links.
 */
export const settleOwedMergesOf = async (ctx: Pick<MutationCtx, "db">, userId: string, threadId: Id<"threads">, at: number): Promise<void> => {
    await someLinkOfThread(ctx, userId, threadId, async (row) => {
        if (row.mergedAt !== undefined && row.mergeSettledAt === undefined) {
            await settleMergedLinkRow(ctx, row._id, at);
        }

        return false;
    });
};

/**
 * Visits the links of one chat, paged over its own index, and stops at the first row `visit` accepts. Returns whether one was
 * accepted. Every link is reached, so no chat's link count is cut short; a visit may patch the row it is given.
 */
export const someLinkOfThread = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    threadId: Id<"threads">,
    visit: (row: Doc<"pullRequestThreads">) => boolean | Promise<boolean>,
): Promise<boolean> => {
    let cursor: string | null = null;

    for (;;) {
        const page = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", userId).eq("threadId", threadId))
            .paginate({ cursor, numItems: LINK_PAGE_SIZE });

        for (const row of page.page) {
            if (await visit(row)) {
                return true;
            }
        }

        if (page.isDone) {
            return false;
        }

        cursor = page.continueCursor;
    }
};
