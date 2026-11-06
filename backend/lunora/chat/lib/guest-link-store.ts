/**
 * Guest links, the parts that need no procedure builder (`chat/guest-links.ts`): the lifetimes and caps,
 * the token helpers, and the removal that archiving or deleting a thread shares with a revoke. Kept apart
 * so `agent/threads.ts` can call the removal without importing the procedures.
 */
import { stripHiddenText } from "@neore/ai/utils";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { sha256Hex } from "../../lib/crypto";
import { deleteShardRoute } from "../../lib/shard-routes";

/** How long a link lasts. */
export const GUEST_LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** A guest message is a note, not a document. */
export const GUEST_MESSAGE_MAX_CHARS = 2000;

/** Messages waiting for the owner, per link. A guest who reaches it is refused until the owner acts. */
export const GUEST_MAX_HELD_PER_LINK = 20;

/** Rows (held and sent) one link keeps; the cap above leaves room for the owner's sent ones. */
export const GUEST_MAX_ROWS_PER_LINK = 100;

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

/**
 * One link with its messages, returning its route's hash for the caller to remove once the write has gone through (a
 * route write is global and does not roll back, so it goes after the rows, as `removeGuestLinkRows` does).
 */
export const deleteGuestLink = async (ctx: Pick<MutationCtx, "db">, link: LinkRow): Promise<string> => {
    const messages = await ctx.db
        .query("threadGuestMessages")
        .withIndex("by_link", (q) => q.eq("linkId", link._id))
        .collect();

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
        .collect();

    for (const link of links) {
        const messages = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_link", (q) => q.eq("linkId", link._id))
            .collect();

        for (const message of messages) {
            await ctx.db.delete("threadGuestMessages", message._id);
        }

        await ctx.db.delete("threadGuestLinks", link._id);
    }

    return links.map((link) => link.linkHash);
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
