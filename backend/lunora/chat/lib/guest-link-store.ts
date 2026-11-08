/**
 * Guest links, the parts that need no procedure builder (`chat/guest-links.ts`): the lifetime and caps, the token and text
 * helpers, and the removal that a revoke, the sweep and archiving, trashing, deleting, locking or making a thread temporary
 * share. Kept apart so `agent/threads.ts` can call the removal without importing the procedures.
 */
import { stripHiddenText } from "@neore/ai/utils";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/internal";
import { sha256Hex } from "../../lib/crypto";
import { currentShard, ROOT_SHARD_KEY } from "../../lib/shard-context";
import { deleteShardRoute } from "../../lib/shard-routes";
import { runAfterOnShard } from "../../lib/shard-scheduler";

/**
 * How long a link lasts. Every link's `expiresAt` is its `createdAt` plus this, never anything else: the removal reads a
 * thread's links in `expiresAt` order as the order they were made in, and stops at the first one made after its cut-off
 * (`removeGuestLinkRows`). A link with its own lifetime would break that order.
 */
export const GUEST_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** A guest message is a note, not a document. */
export const GUEST_MESSAGE_MAX_CHARS = 2000;

/** Messages waiting for the owner, per link. A guest who reaches it is refused until the owner acts. */
export const GUEST_MAX_HELD_PER_LINK = 20;

/** Rows (held and sent) one link keeps; the held cap above leaves room for the owner's sent ones. */
export const GUEST_MAX_ROWS_PER_LINK = 100;

/** The most links of one thread a removal reads: a thread has one live link at a time, and lapsed ones go with the sweep. */
export const GUEST_LINK_REMOVAL_CAP = 50;

/** Tokens are two UUIDs without dashes: 64 characters. Anything much longer is not one. */
export const GUEST_TOKEN_MAX_LENGTH = 128;

export const newGuestToken = (): string => `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");

/** A token's stored form: only this ever reaches the database. */
export const hashGuestToken = async (token: string): Promise<string> => await sha256Hex(token);

/** The shape of a mention as the group parser reads one (`chat/group/logic.ts`), without its participant list. */
const GUEST_MENTION_SHAPE = /(?:^|[^\w@.])@[a-z0-9]/i;

/**
 * Why a guest's text cannot be sent later, or `undefined`. A text that starts with `/` could select one of the owner's
 * commands or skills, and a mention could choose who answers in a group chat: neither is a guest's to decide. Refused when
 * posted, so no note is left waiting on a Send that can only fail.
 */
export const unsendableGuestText = (text: string): string | undefined => {
    const plain = stripHiddenText(text).text.trimStart();

    if (plain.startsWith("/")) {
        return "A message cannot start with /.";
    }

    return GUEST_MENTION_SHAPE.test(plain) ? "A message cannot @mention anyone." : undefined;
};

/** The text a guest may leave, trimmed, or `null` when it is empty or over the cap. */
export const cleanGuestText = (text: string): string | null => {
    // Hidden characters can carry instructions the person never sees: they go, as they do from an ordinary prompt.
    const trimmed = stripHiddenText(text).text.trim();

    return trimmed.length === 0 || trimmed.length > GUEST_MESSAGE_MAX_CHARS ? null : trimmed;
};

interface LinkRow {
    _id: Id<"threadGuestLinks">;
    linkHash: string;
}

/** Messages one removal deletes per call, across all the links it takes, so a call's writes stay bounded. */
export const GUEST_MESSAGE_REMOVAL_PAGE = 100;

/** What is left of a call's message deletes ({@link GUEST_MESSAGE_REMOVAL_PAGE}), shared by every link the call removes. */
export interface RemovalBudget {
    left: number;
}

export const newRemovalBudget = (): RemovalBudget => {
    return { left: GUEST_MESSAGE_REMOVAL_PAGE };
};

/**
 * As many of a link's messages as the budget allows, and the link itself once none are left. Returns the link's route hash
 * when the link went, for the caller to hand to {@link scheduleGuestLinkRouteDrop}, or `undefined` while messages remain:
 * the caller runs again, and the link is never deleted ahead of its messages.
 */
export const deleteGuestLink = async (ctx: Pick<MutationCtx, "db">, link: LinkRow, budget: RemovalBudget = newRemovalBudget()): Promise<string | undefined> => {
    // One past the budget tells a link whose messages exactly use it up from one that holds more.
    const messages = await ctx.db
        .query("threadGuestMessages")
        .withIndex("by_link", (q) => q.eq("linkId", link._id))
        .take(budget.left + 1);
    const deleting = messages.slice(0, budget.left);

    for (const message of deleting) {
        await ctx.db.delete("threadGuestMessages", message._id);
    }

    budget.left -= deleting.length;

    if (messages.length > deleting.length) {
        return undefined;
    }

    await ctx.db.delete("threadGuestLinks", link._id);

    return link.linkHash;
};

/**
 * One batch of the thread's links made at or before `before`, and what guests left on them, minus their routes: the rows
 * go with the caller's write, and the returned hashes are the routes the caller schedules for removal.
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
    const budget = newRemovalBudget();

    for (const link of links) {
        // Every link lasts the same time, so the index's `expiresAt` order is the order they were made in: from the first
        // link made after the cut-off on, none is the removal's to take.
        if (link.createdAt > before) {
            return { done: true, hashes };
        }

        const hash = await deleteGuestLink(ctx, link, budget);

        // An unfinished link means the call's budget is spent; the rest wait for the next call.
        if (hash === undefined) {
            return { done: false, hashes };
        }

        hashes.push(hash);
    }

    return { done: links.length < GUEST_LINK_REMOVAL_CAP, hashes };
};

/** The most hashes one route-removal job (`dropGuestLinkRoutesJob`) takes; {@link scheduleGuestLinkRouteDrop} splits longer lists. */
export const GUEST_ROUTE_BATCH = 50;

/** Attempts of a route removal (`dropGuestLinkRoutesJob`) before it is left to account erasure. */
export const GUEST_ROUTE_DROP_ATTEMPTS = 5;

/** The wait before retry `attempt` of a route removal: one minute, doubling. */
export const guestRouteDropDelayMs = (attempt: number): number => 60_000 * 2 ** (attempt - 1);

/**
 * Hands the routes of removed links to a job on this shard. A route lives in global storage, which does not roll back with
 * this shard's write; a scheduled job does (it is dropped with a write that fails), so a route goes only after the rows
 * it points at are gone for good. The job re-checks that no link row holds the hash before it deletes the route.
 */
export const scheduleGuestLinkRouteDrop = async (ctx: Pick<MutationCtx, "scheduler">, linkHashes: string[], attempt = 0): Promise<void> => {
    // One job per batch the job accepts, so a caller that removed more links (a replace over several passes) is never refused.
    for (let start = 0; start < linkHashes.length; start += GUEST_ROUTE_BATCH) {
        await runAfterOnShard(
            ctx.scheduler,
            attempt === 0 ? 0 : guestRouteDropDelayMs(attempt),
            internal.chat.guest_links.dropGuestLinkRoutesJob,
            { attempt, linkHashes: linkHashes.slice(start, start + GUEST_ROUTE_BATCH) },
            currentShard() ?? ROOT_SHARD_KEY,
        );
    }
};

/**
 * Deletes routes right away, for account erasure only: the account's rows go in the same pass and its remaining routes
 * with `deleteShardRoutesOf`, so a route dropped ahead of a failed batch points at an account that is going anyway. A
 * failure is logged, not thrown, so the erasure does not stall on it.
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
 * One batch of a thread's links made at or before `before` (by default, every link so far) and their messages, with their
 * routes scheduled for removal once this write commits. True once none are left; the caller runs it again otherwise.
 */
export const revokeGuestLinksForThread = async (
    ctx: Pick<MutationCtx, "db" | "now" | "scheduler">,
    threadId: Id<"threads">,
    before: number = ctx.now,
): Promise<boolean> => {
    const { done, hashes } = await removeGuestLinkRows(ctx, threadId, before);

    await scheduleGuestLinkRouteDrop(ctx, hashes);

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
