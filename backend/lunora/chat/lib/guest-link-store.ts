/**
 * Guest links, the parts that need no procedure builder (`chat/guest-links.ts`): the caps and the removal that
 * archiving, trashing, deleting, locking or making a thread temporary shares with the sweep. Kept apart so
 * `agent/threads.ts` can call the removal without importing the procedures.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { deleteShardRoute } from "../../lib/shard-routes";

/** Rows (held and sent) one link keeps. */
export const GUEST_MAX_ROWS_PER_LINK = 100;

/** The most links of one thread a removal reads: a thread has one live link at a time, and lapsed ones go with the sweep. */
export const GUEST_LINK_REMOVAL_CAP = 50;

interface LinkRow {
    _id: Id<"threadGuestLinks">;
    linkHash: string;
}

/**
 * One link with its messages, returning its route's hash for the caller to remove once the write has gone through (a
 * route write is global and does not roll back, so it goes after the rows, as `removeGuestLinkRows` does).
 */
export const deleteGuestLink = async (ctx: Pick<MutationCtx, "db">, link: LinkRow): Promise<string> => {
    const messages = await ctx.db
        .query("threadGuestMessages")
        .withIndex("by_link", (q) => q.eq("linkId", link._id))
        .take(GUEST_MAX_ROWS_PER_LINK);

    for (const message of messages) {
        await ctx.db.delete("threadGuestMessages", message._id);
    }

    await ctx.db.delete("threadGuestLinks", link._id);

    return link.linkHash;
};

/**
 * A thread's links and what guests left on them, minus their routes: the shard-local rows go with the caller's
 * write, and the returned hashes are the routes the caller removes once that write has gone through. A route write
 * is global and does not roll back, so a route deleted before the write could leave a live link unreachable.
 */
export const removeGuestLinkRows = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<string[]> => {
    const links = await ctx.db
        .query("threadGuestLinks")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .take(GUEST_LINK_REMOVAL_CAP);
    const hashes: string[] = [];

    for (const link of links) {
        hashes.push(await deleteGuestLink(ctx, link));
    }

    return hashes;
};

/**
 * Removes the routes of links whose rows are already gone. A failure is logged, not thrown: a leftover route answers
 * "not active", and the operation that removed the rows (an archive, a trash, a delete, the sweep) must still complete.
 */
export const dropGuestLinkRoutes = async (ctx: Pick<MutationCtx, "db">, linkHashes: string[]): Promise<void> => {
    for (const linkHash of linkHashes) {
        try {
            await deleteShardRoute(ctx, "guest-link", linkHash);
        } catch (error) {
            console.error("[guest-links] Failed to drop the route of a removed link:", error);
        }
    }
};

/** Every link of a thread, with what guests left on them: a revoke, an archive, a delete. */
export const revokeGuestLinksForThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">): Promise<void> => {
    const linkHashes = await removeGuestLinkRows(ctx, threadId);

    await dropGuestLinkRoutes(ctx, linkHashes);
};
