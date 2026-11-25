/**
 * The thread grants that give access. A grant row a removal or an account merge is deleting holds its revision negated
 * (`grant-revision.ts#tombstone`); the stamp and the delete are two statements, so a removal that stops between them
 * (an invocation limit, an eviction, a thrown claim) leaves the row. Such a row grants nothing: every reader that decides
 * access goes through these, so a half-finished removal never leaves the grantee in. A re-grant writes a new row beside it
 * and clears it (`sharing.ts#insertThreadAccess`), and a later removal of the row stamps it again and deletes it.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { type StoredRow, storedRows } from "../lib/stored-row";

/** Copies of one grant read to find a live one: nothing keys `(threadId, userId)` unique, but more than a few is a fault. Past them, no access. */
export const GRANT_COPIES_SCANNED = 4;

/** Whether a grant row holds a removal's or a merge's tombstone: it is being deleted, and grants nothing. */
export const isTombstonedGrant = (grant: { revision?: number | null }): boolean => typeof grant.revision === "number" && grant.revision < 0;

/**
 * The grant `userId` holds on `threadId` that is not being deleted, or `null`. `primary` for a caller about to act on it: a
 * replica may still hold a grant a removal deleted.
 */
export const findLiveGrant = async (
    ctx: Pick<QueryCtx, "db">,
    threadId: Id<"threads">,
    userId: string,
    { primary = false }: { primary?: boolean } = {},
): Promise<StoredRow<Doc<"threadAccess">> | null> => {
    const { page } = await ctx.db.threadAccess.findMany({
        ...(primary && { consistency: "primary" as const }),
        limit: GRANT_COPIES_SCANNED,
        where: { threadId, userId },
    });

    return storedRows(page).find((grant) => !isTombstonedGrant(grant)) ?? null;
};

/** Whether anyone holds a grant on `threadId` that is not being deleted. */
export const threadHasLiveGrant = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<boolean> => {
    const { page } = await ctx.db.threadAccess.findMany({ limit: GRANT_COPIES_SCANNED, where: { threadId } });

    // Past a page of tombstones, taken as shared: the callers refuse what a shared chat may not do.
    return page.length === GRANT_COPIES_SCANNED || storedRows(page).some((grant) => !isTombstonedGrant(grant));
};
