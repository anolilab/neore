/**
 * Guest links, the parts that need no procedure builder (`chat/guest-links.ts`): the caps and the removal that
 * archiving, trashing, deleting, locking or making a thread temporary shares with the sweep. Kept apart so
 * `agent/threads.ts` can call the removal without importing the procedures.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/internal";
import { currentShard, ROOT_SHARD_KEY } from "../../lib/shard-context";
import { deleteShardRoute } from "../../lib/shard-routes";
import { runAfterOnShard } from "../../lib/shard-scheduler";

/** Rows (held and sent) one link keeps. */
export const GUEST_MAX_ROWS_PER_LINK = 100;

/** The most links of one thread a removal reads: a thread has one live link at a time, and lapsed ones go with the sweep. */
export const GUEST_LINK_REMOVAL_CAP = 50;

interface LinkRow {
    _id: Id<"threadGuestLinks">;
    linkHash: string;
}

/** Messages one removal deletes per link per call. */
export const GUEST_MESSAGE_REMOVAL_PAGE = 100;

/**
 * One page of a link's messages, and the link itself once none are left. Returns the link's route hash when the link
 * went, for the caller to remove once the write has gone through (a route write is global and does not roll back), or
 * `undefined` while messages remain: the caller runs again, and the link is never deleted ahead of its messages.
 */
export const deleteGuestLink = async (ctx: Pick<MutationCtx, "db">, link: LinkRow): Promise<string | undefined> => {
    // One past the page tells a link that holds exactly one page (a full one) from one that holds more.
    const messages = await ctx.db
        .query("threadGuestMessages")
        .withIndex("by_link", (q) => q.eq("linkId", link._id))
        .take(GUEST_MESSAGE_REMOVAL_PAGE + 1);

    for (const message of messages.slice(0, GUEST_MESSAGE_REMOVAL_PAGE)) {
        await ctx.db.delete("threadGuestMessages", message._id);
    }

    if (messages.length > GUEST_MESSAGE_REMOVAL_PAGE) {
        return undefined;
    }

    await ctx.db.delete("threadGuestLinks", link._id);

    return link.linkHash;
};

/**
 * One batch of the thread's links made at or before `before`, and what guests left on them, minus their routes: the rows
 * go with the caller's write, and the returned hashes are the routes the caller removes once that write has gone through.
 * `done` is false while such rows remain; the caller runs it again. A link made after `before` (once the thread was
 * restored or unlocked) is not the removal's to take, and does not keep the removal going.
 */
export const removeGuestLinkRows = async (
    ctx: Pick<MutationCtx, "db">,
    threadId: Id<"threads">,
    before: number,
): Promise<{ done: boolean; hashes: string[] }> => {
    const links = await ctx.db
        .query("threadGuestLinks")
        .withIndex("by_thread_expiresAt", (q) => q.eq("threadId", threadId))
        .take(GUEST_LINK_REMOVAL_CAP);
    const hashes: string[] = [];

    for (const link of links) {
        // Every link lasts the same time, so the index's `expiresAt` order is the order they were made in: from the first
        // link made after the cut-off on, none is the removal's to take.
        if (link.createdAt > before) {
            return { done: true, hashes };
        }

        const hash = await deleteGuestLink(ctx, link);

        // One unfinished link per call keeps the write bounded; the rest wait for the next call.
        if (hash === undefined) {
            return { done: false, hashes };
        }

        hashes.push(hash);
    }

    return { done: links.length < GUEST_LINK_REMOVAL_CAP, hashes };
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

/**
 * One batch of a thread's links made at or before `before` (by default, every link so far), their messages and routes.
 * True once none are left; the caller runs it again otherwise.
 */
export const revokeGuestLinksForThread = async (ctx: Pick<MutationCtx, "db" | "now">, threadId: Id<"threads">, before: number = ctx.now): Promise<boolean> => {
    const { done, hashes } = await removeGuestLinkRows(ctx, threadId, before);

    await dropGuestLinkRoutes(ctx, hashes);

    return done;
};

/**
 * Every link of a thread made by now, for a write that cannot re-run itself (an archive, a trash, a lock, a temporary
 * chat): the first batch now, and a continuation on this shard until none are left. The continuation carries the cut-off,
 * so a link the owner makes after restoring or unlocking the thread is not taken with the old ones.
 */
export const withdrawGuestLinksForThread = async (
    ctx: Pick<MutationCtx, "db" | "now" | "scheduler">,
    threadId: Id<"threads">,
    before: number = ctx.now,
): Promise<void> => {
    if (!(await revokeGuestLinksForThread(ctx, threadId, before))) {
        await runAfterOnShard(ctx.scheduler, 0, internal.chat.guest_links.continueGuestLinkRemoval, { before, threadId }, currentShard() ?? ROOT_SHARD_KEY);
    }
};
