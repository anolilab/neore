/**
 * A thread grant's revision: one number per thread and grantee that every write to the grant advances (a grant, a
 * renewal or change, a removal), so a client can tell a read that saw an older state of the grant from one that saw a
 * newer one. A server's clock cannot: a renewal pushes nothing to a live query, so a later one-shot read from a replica
 * that has not seen a removal looks newer than the removal's push.
 *
 * The count lives in `threadAccessRevisions`, one row per thread and grantee (a unique key), and is copied onto the
 * grant row. `.global()` (D1) writes are not one transaction, so the count is claimed by a conditional write before
 * the grant row is written: two writers never take the same revision, and the count is never below a revision a grant
 * row holds. A removal advances it again once the row is gone (`removeGrant`). The count outlives the grant row, so the
 * next grant continues past it and a denial names the removal's revision; a chat deleted for good erases it, and its
 * purge mark refuses a grant or a count written after ({@link markThreadPurged}).
 */
import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";
import { withoutUndefined } from "../lib/patch";
import { mergedGuestTarget } from "../lib/shard-routes";
import { type StoredRow, storedRow, storedRows } from "../lib/stored-row";
import { meetsThreadPermission, type ThreadPermission } from "./thread-read-access";

/** Claims a revision again when a concurrent write took the one read; more than a few means something else is wrong. */
const ADVANCE_ATTEMPTS = 5;

/** D1 queries one Worker invocation may run on the Free plan; past it, every further query of the invocation fails. */
const INVOCATION_D1_QUERIES = 50;

/**
 * D1 queries a write takes: a patch, a conditional patch and a delete each read the row before they write it. A
 * conditional patch goes round again (up to 16 times, with no cap a caller can set) only when a commit landed between
 * its read and its write and left its `where` true; every write here but a merge's own `userId`/`ownerId` move changes
 * the `revision` it is conditional on, so a race usually costs one read more and a miss. The headroom left out of
 * {@link GRANT_PAGE_STATEMENTS} pays for that, not for the 16-round worst case (`docs/agents/lunora-upstream.md`).
 */
export const WRITE_STATEMENTS = 2;

/**
 * D1 queries a claim ({@link advanceGrantRevision}) takes uncontended: the count read, then its conditional write, or its
 * insert and the reads of the merge mark and the purge mark.
 */
const CLAIM_STATEMENTS = 4;

/** How long a chat's purge mark outlives its purge: far past any write that read the chat's grants or invite before it. */
export const PURGE_MARK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Marks `threadId` deleted for good, before its purge reads a grant or a revision (`agent/sharing.ts#revokeThreadGrantsPage`).
 * A write that makes a grant or a count reads the mark after its own write ({@link isThreadPurged}): one that misses it
 * landed before the mark, so the purge's later reads find what it wrote; one that finds it takes its write back. There
 * is no transaction across `.global()` writes, so a check of the chat before the write could not close that race.
 */
export const markThreadPurged = async (ctx: Pick<MutationCtx, "db" | "now">, threadId: Id<"threads">): Promise<void> => {
    if (await isThreadPurged(ctx, threadId)) {
        return;
    }

    try {
        await ctx.db.insert("threadPurgeMarks", { purgedAt: ctx.now, threadId });
    } catch (error: unknown) {
        // Another pass of the purge wrote it first.
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }
};

/** Whether `threadId` was deleted for good ({@link markThreadPurged}), read from the primary. */
export const isThreadPurged = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<boolean> =>
    (await ctx.db.threadPurgeMarks.findFirst({ consistency: "primary", where: { threadId } })) !== null;

/** The refusal of a grant write to a chat deleted for good. */
export const throwThreadPurged = (): never => {
    throw new LunoraError("NOT_FOUND", "This chat was deleted.");
};

/**
 * A grant row about to be deleted (a copy a merge deletes, a grant a removal deletes) holds the negative of the
 * revision its delete claimed: no write takes it (a change finds the grant gone, a settle passes it by), and it grants
 * nothing (`live-grant.ts`), also when the delete never comes; a revision read reports the one it stands for
 * ({@link grantRowRevision}). A re-grant clears such a row, a later removal stamps it again and deletes it, and a merge
 * never keeps one. There is no conditional delete on a `.global()` table,
 * so this is what makes the delete safe: a change that read the row before the mark misses and reads it again, and one
 * that reads it after refuses, so none lands between the check and the delete. A merge that stops short puts the
 * revision back.
 */
const tombstone = (revision: number): number => -revision;

/** Whether a grant row holds a merge's or a removal's {@link tombstone}. */
const isTombstone = (revision: number | undefined): boolean => revision !== undefined && revision < 0;

/** The revision a grant row stands for: a tombstone reads as the revision it marks. */
const grantRowRevision = (revision: number | undefined): number => Math.abs(revision ?? 0);

/**
 * Statements (D1 queries) a batched grant path (a trashed chat's revocation, an account merge's grant pages, an account
 * erase) plans one invocation for, uncontended. The rest of {@link INVOCATION_D1_QUERIES} is room for writes racing it: a
 * claim taken again, a removal's stamp read again, a settle that writes a raced grant.
 */
export const GRANT_PAGE_STATEMENTS = INVOCATION_D1_QUERIES - 18;

/**
 * Statements one {@link removeGrant} takes uncontended: the row read, the grantee's merge mark, a claim, the stamp, the
 * delete, a second claim, and the settle's two reads. A guest whose merge has started (or whose count a claim folded)
 * skips the settle, which pays for each claim's read of the guest's count before it claims under the merged account.
 */
export const REMOVE_GRANT_STATEMENTS = 2 + CLAIM_STATEMENTS + 2 * WRITE_STATEMENTS + CLAIM_STATEMENTS + 2;

interface GrantKey {
    /** The grant row's own revision when there is one (a grant from before revisions reads as 0). */
    current?: number;
    /**
     * The account a guest `userId` merges into, once its merge has started: a claim that finds no count of the guest's
     * makes none and claims under this account. Set by a claim that folded a count it made, so the next claim with the
     * same key goes there at once.
     */
    mergingInto?: string;
    ownerId?: string;
    threadId: Id<"threads">;
    userId: string;
}

/**
 * Advances the grant's revision and returns the new one, which no other write took. Call before writing the grant, and
 * put the result on the grant row (an insert or a patch). Reads from the primary: a replica's older count would hand out
 * a revision already used. A count it makes is followed by a read of the grantee's merge mark ({@link mergedGuestTarget}):
 * the merge marks a guest before it reads a count, so either the merge's reads find the new count, or that read finds the
 * mark and the count is folded into the account the guest merges into. A count that already existed is one the merge's
 * reads find. The chat's purge mark is read beside it the same way ({@link markThreadPurged}): a count made after a chat
 * was deleted for good is deleted again and the claim refused, so none outlives the purge.
 */
export const advanceGrantRevision = async (ctx: Pick<MutationCtx, "db">, key: GrantKey): Promise<number> => {
    const { current, ownerId, threadId, userId } = key;

    for (let attempt = 0; attempt < ADVANCE_ATTEMPTS; attempt += 1) {
        const counter = storedRow(await ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { threadId, userId } }));

        // A merge is folding this guest's count (it marked it before its delete): claimed under the account it merges
        // into, past the revision the mark stands for, so the delete loses no revision a claim handed out.
        if (counter && isTombstone(counter.revision)) {
            const into = key.mergingInto ?? (await mergedGuestTarget(ctx, userId));

            if (into === null) {
                throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
            }

            key.mergingInto = into;

            return await advanceGrantRevision(ctx, { current: Math.max(current ?? 0, grantRowRevision(counter.revision)), ownerId, threadId, userId: into });
        }

        const revision = Math.max(counter?.revision ?? 0, current ?? 0) + 1;

        if (counter) {
            const { applied } = await ctx.db.patchIf("threadAccessRevisions", counter._id, { patch: { revision }, where: { revision: counter.revision } });

            if (applied) {
                return revision;
            }

            continue;
        }

        if (key.mergingInto !== undefined) {
            return await advanceGrantRevision(ctx, { current, ownerId, threadId, userId: key.mergingInto });
        }

        let id: string;

        try {
            id = await ctx.db.insert("threadAccessRevisions", { ...(ownerId !== undefined && { ownerId }), revision, threadId, userId });
        } catch (error: unknown) {
            // Another write made the row first: read it and claim past it.
            if (!isUniqueViolation(error)) {
                throw error;
            }

            continue;
        }

        // The merge marked the guest between the read above and the insert, and may have read its counts already. The
        // chat's purge may have read its counts already too: a count made after its mark is taken back.
        const [into, purged] = await Promise.all([mergedGuestTarget(ctx, userId), isThreadPurged(ctx, threadId)]);

        if (purged) {
            await ctx.db.delete("threadAccessRevisions", id as Id<"threadAccessRevisions">);
            throwThreadPurged();
        }

        if (into !== null) {
            await foldGuestRevision(ctx, { _id: id as Id<"threadAccessRevisions">, ownerId, revision, threadId }, into, true);
            key.mergingInto = into;
        }

        return revision;
    }

    throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
};

/**
 * Removes a grant row: the revision advances before the delete (so a failure after it still leaves the count past the
 * grant's) and again after it. Counted under the grantee the row names: the first claim is stamped on the row as its
 * {@link tombstone}, conditional on the grantee and revision read, so an account merge or a change that wrote the row
 * since makes the stamp miss, and the removal reads it again; a change that reads the row after the stamp refuses
 * (`writeGrant` answers the grant gone), so no change lands between the stamp and the delete and is erased by it. A
 * reader sees the removal's revision on the stamped row. A row already gone claims nothing; one a removal stopped short
 * of deleting is stamped again and deleted. `true` when this call removed the row.
 */
export const removeGrant = async (
    ctx: Pick<MutationCtx, "db">,
    grant: GrantKey & { _id: Id<"threadAccess"> },
    { expected }: { expected?: number } = {},
): Promise<boolean> => {
    for (let attempt = 0; attempt < ADVANCE_ATTEMPTS; attempt += 1) {
        const current = storedRow(await ctx.db.threadAccess.findFirst({ consistency: "primary", where: { _id: grant._id } }));

        // Gone already: whatever removed it counted the removal (a removal advances after its delete), and a chat deleted
        // for good erased the count, which a claim here would make again.
        if (!current) {
            return false;
        }

        // `expected`: removed only while the row holds that revision; a write since is someone else's and is kept. The
        // stamp below is conditional on the revision read, so a write after this check makes it miss and come back here.
        if (expected !== undefined && (current.revision ?? 0) !== expected) {
            return false;
        }

        // A guest whose merge has started: counted under the guest while it still has a count (its denial names it, and
        // the merge folds it), under the account it merges into once the merge moved that count.
        const merging = await mergedGuestTarget(ctx, current.userId);
        const key: GrantKey = {
            ...grant,
            current: grantRowRevision(current.revision),
            ...(merging !== null && { mergingInto: merging }),
            userId: current.userId,
        };
        const revision = await advanceGrantRevision(ctx, key);
        const { applied } = await ctx.db.patchIf("threadAccess", grant._id, {
            patch: { revision: tombstone(revision) },
            where: { revision: current.revision ?? null, userId: current.userId },
        });

        if (!applied) {
            continue;
        }

        await ctx.db.delete("threadAccess", grant._id);
        await advanceGrantRevision(ctx, key);

        // A new grant may have claimed its revision between the two advances: move it past the removal's. A guest marked
        // as merging takes no new grant (one written before the mark removes itself), so there is none to move.
        if (merging === null && key.mergingInto === undefined) {
            await settleGrant(ctx, key.threadId, key.userId);
        }

        return true;
    }

    throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
};

/**
 * Grant rows {@link settleGrant} reads per page. One grantee should hold one grant to one chat, but nothing keys
 * `(threadId, userId)` unique: an account merge from before {@link mergeGrantsPage} left two, and concurrent accepts of
 * one invite each insert one. So a page is never taken as every copy: the settle reads until a page comes back short.
 */
const GRANT_COPIES_READ = 4;

/**
 * Statements one {@link settleGrant} may take uncontended: the count read, a read per page, a claim and a write per copy
 * moved, all counted as they go. A grantee holding more copies than these pay for is refused once the budget is spent
 * (`CONFLICT`); the next settle passes the copies this one moved (they hold the count it claimed, which it takes as its
 * own) and moves the next ones.
 */
const SETTLE_BUDGET = GRANT_PAGE_STATEMENTS;

/**
 * Moves every grant row of `userId` on `threadId` that is below the count past it, under one revision for them all, each
 * write conditional on the revision read; a copy a change wrote since goes through {@link writeGrant}. The revision is a
 * claim past the count, or the count itself when a live copy already holds it: a settle refused part way (its budget
 * spent) left the copies it moved at its claim, and the next one moves the rest to that same revision rather than past
 * it, so no copy is left below a revision another copy answers with. A new grant and a removal write different rows:
 * each settles after its own write (the grant after its insert, the removal after its last advance), so whichever reads
 * second sees the other's write, and no grant stays below a revision a denial names. The copies are read in pages in
 * creation order, each page from the last copy read on (`_creationTime` at least the last one's; the copies of that
 * instant already seen are passed by), so a copy moved or deleted meanwhile shifts no later one past the read, and no
 * copy is read twice but for one sharing an instant with the last. Every page is read until one comes back short: a card
 * that saw one copy's revision drops the answers of a copy left below it. Uncontended, {@link SETTLE_STATEMENTS} when the
 * copies fit one page. Returns the revision it wrote on each grant it moved.
 */
export const settleGrant = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, userId: string): Promise<ReadonlyMap<Id<"threadAccess">, number>> => {
    const written = new Map<Id<"threadAccess">, number>();
    const seen = new Set<Id<"threadAccess">>();
    /** The last copy's creation time read, and the copies of that instant seen (a page from it reads them again). */
    let last: { at: number; ids: number } | undefined;
    const readCopies = async () => {
        const limit = GRANT_COPIES_READ + (last?.ids ?? 0);
        const { page } = await ctx.db.threadAccess.findMany({
            consistency: "primary",
            limit,
            orderBy: [{ _creationTime: "asc" }],
            where: { threadId, userId, ...(last !== undefined && { _creationTime: { gte: last.at } }) },
        });

        return { limit, page };
    };

    const [first, counter] = await Promise.all([readCopies(), ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { threadId, userId } })]);
    const count = grantRowRevision(storedRow(counter)?.revision);
    let { limit, page } = first;
    let revision: number | undefined;
    /** A live copy at the count: the count is a grant's revision (a refused settle's claim), not a denial's. */
    let heldAtCount = false;
    // The count read and the first page.
    let statements = 2;

    const spend = (cost: number): void => {
        // The claim, while none is made yet, stays reserved.
        if (statements + cost + (revision === undefined ? CLAIM_STATEMENTS : 0) > SETTLE_BUDGET) {
            throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
        }

        statements += cost;
    };

    for (;;) {
        const rows = storedRows(page).filter((grant) => !seen.has(grant._id));

        for (const grant of rows) {
            seen.add(grant._id);
            last = last?.at === grant._creationTime ? { at: last.at, ids: last.ids + 1 } : { at: grant._creationTime, ids: 1 };
            heldAtCount ||= count > 0 && grant.revision === count;

            // A copy a merge is deleting is passed by: moving it would take its tombstone, and a change could land before the delete.
            // Once a claim is made, a copy at the count is below it and moves too.
            if (isTombstone(grant.revision) || (grant.revision ?? 0) >= (revision ?? count)) {
                continue;
            }

            spend(WRITE_STATEMENTS);

            if (revision === undefined) {
                revision = heldAtCount ? count : await advanceGrantRevision(ctx, { current: count, ownerId: grant.ownerId, threadId, userId });
                statements += heldAtCount ? 0 : CLAIM_STATEMENTS;
            }

            const { applied } = await ctx.db.patchIf("threadAccess", grant._id, { patch: { revision }, where: { revision: grant.revision ?? null } });
            const wrote = applied ? revision : await writeGrant(ctx, grant._id, {});

            if (wrote !== false) {
                written.set(grant._id, wrote);
            }
        }

        if (page.length < limit) {
            return written;
        }

        spend(1);
        ({ limit, page } = await readCopies());
    }
};

/** Statements one {@link settleGrant} takes uncontended when the copies fit one page: its two reads, a claim and a write per copy. */
const SETTLE_STATEMENTS = 2 + CLAIM_STATEMENTS + GRANT_COPIES_READ * WRITE_STATEMENTS;

/**
 * The grant revision `userId` last had on `threadId`, for an answer that says they do not read it (a removed or ended
 * grant): `undefined` when no grant was ever written with one, or its chat was deleted for good. It names only the
 * caller's own grant, which is all row-level security lets them read.
 */
export const lastGrantRevision = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, userId: string): Promise<number | undefined> => {
    // Primary, as a claim reads it: a replica that has not seen the removal's second advance names a revision a
    // lagging copy of the grant still holds, and the card would keep that copy's answers.
    const counter = storedRow(await ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { threadId, userId } }));

    // A count a merge is folding holds its tombstone, which stands for the revision it marks.
    return counter === null ? undefined : grantRowRevision(counter.revision);
};

interface GrantChange {
    expiresAt?: number;
    permission?: ThreadPermission;
    /** Moves the grant to another grantee (an account merge); its revision is then claimed under that grantee. */
    userId?: string;
}

/**
 * Writes a change to grant `grantId` under a newly claimed revision. The claim and the grant write are two statements,
 * so the write is conditional on the revision the row held when read: a concurrent change that wrote a later revision
 * in between makes it miss, and it claims again past that one. An older revision never overwrites a newer one.
 * `expected` writes only while the row holds that revision (a write since is someone else's and is kept). The revision
 * written, or `false` when the grant is gone (a removal won) or no longer holds `expected`.
 */
export const writeGrant = async (
    ctx: Pick<MutationCtx, "db">,
    grantId: Id<"threadAccess">,
    change: GrantChange,
    { expected }: { expected?: number } = {},
): Promise<number | false> => {
    const written = await writeGrantOver(ctx, grantId, (grant) => (expected !== undefined && (grant.revision ?? 0) !== expected ? null : change));

    return written === false || written === null ? false : written.revision;
};

/**
 * Writes like {@link writeGrant}, with the change decided from the row the conditional write replaces: `change` gets that
 * row (read again on a lost race) and answers the change, or `null` to write nothing. The row it replaced and the revision
 * written; `false` when the grant is gone or a merge is deleting it, `null` when `change` declined.
 */
export const writeGrantOver = async (
    ctx: Pick<MutationCtx, "db">,
    grantId: Id<"threadAccess">,
    change: (grant: StoredRow<Doc<"threadAccess">>) => GrantChange | null,
): Promise<false | null | { replaced: StoredRow<Doc<"threadAccess">>; revision: number }> => {
    for (let attempt = 0; attempt < ADVANCE_ATTEMPTS; attempt += 1) {
        const grant = storedRow(await ctx.db.threadAccess.findFirst({ consistency: "primary", where: { _id: grantId } }));

        // A merge or a removal is deleting this row (it stamped its tombstone): a write here would go with it.
        if (!grant || isTombstone(grant.revision)) {
            return false;
        }

        const next = change(grant);

        if (next === null) {
            return null;
        }

        const revision = await advanceGrantRevision(ctx, {
            current: grant.revision,
            ownerId: grant.ownerId,
            threadId: grant.threadId,
            userId: next.userId ?? grant.userId,
        });
        const { applied } = await ctx.db.patchIf("threadAccess", grantId, {
            patch: withoutUndefined({ ...next, revision }),
            where: { revision: grant.revision ?? null },
        });

        if (applied) {
            return { replaced: grant, revision };
        }
    }

    throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
};

type GrantTerms = { expiresAt?: number; permission: ThreadPermission };

/**
 * Orders two grants by what they give at `now`: one that has not ended first, then the permission, then the later end
 * (none is never). One row is kept, so a wider grant that ends sooner wins over a narrower one that lasts.
 */
const givesMore = (a: GrantTerms, b: GrantTerms, now: number): boolean => {
    const live = (grant: GrantTerms): boolean => grant.expiresAt === undefined || grant.expiresAt > now;

    if (live(a) !== live(b)) {
        return live(a);
    }

    if (a.permission !== b.permission) {
        return meetsThreadPermission(a.permission, b.permission);
    }

    return a.expiresAt === undefined ? b.expiresAt !== undefined : b.expiresAt !== undefined && a.expiresAt > b.expiresAt;
};

/** Times one chat's merge reads its grants again after a write raced it, before it leaves them for the next page. */
const MERGE_ATTEMPTS = 3;

/**
 * Statements one chat's merge stage takes besides its other copies ({@link MERGE_COPY_STATEMENTS} each): the two
 * reads, the claim, the kept write, and, in the last stage, its move and the settle's two reads.
 */
const MERGE_ATTEMPT_BASE = 2 + CLAIM_STATEMENTS + WRITE_STATEMENTS + WRITE_STATEMENTS + 2;

/**
 * Statements each other copy of a chat's grant takes in a merge stage: its tombstone, then the kept row's check and its
 * delete, or its restore when the stage stops short.
 */
const MERGE_COPY_STATEMENTS = 2 * WRITE_STATEMENTS + 1;

/**
 * One chat's grants of a merged guest moved to the new account, keeping one row there. A stage takes as many copies as
 * `budget` pays for: all of them when they fit (the last stage), else a part, of which it keeps the one that gives
 * more and deletes the rest, leaving the move to a later stage or call. A part always leaves a guest's row out of it,
 * so the next page comes back to the chat. The choice is made from a read, so every write is conditional on the
 * revision that read saw. Under a newly claimed revision, each other copy is marked with its tombstone
 * ({@link tombstone}; a change that read it earlier misses), then the kept row is written, then each other copy is
 * deleted once a read from the primary finds the kept row still there under its grantee (the new account's first, the
 * guest's last), and only in the last stage is the kept row moved to the new account. A miss puts back every tombstone
 * the stage left, reads the chat's grants again and chooses again; whenever a stage stops short, the guest still holds
 * a row to the chat, and the new account never keeps two. The kept row is then settled past the new account's count. A
 * removal of the kept row is caught up to the read before each delete; one landing after that read takes the copy
 * being deleted with it. `"done"` when the guest holds none to the chat and the new account one at most; `"budget"`
 * when the next stage could pass `budget`; `"raced"` after {@link MERGE_ATTEMPTS} misses in a row.
 */
const mergeChatGrants = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    threadId: Id<"threads">,
    from: string,
    to: string,
    budget: { left: number },
): Promise<"budget" | "done" | "raced"> => {
    let misses = 0;

    while (misses < MERGE_ATTEMPTS) {
        // The copies a stage can pay for: the kept one and as many others as the rest of the budget covers.
        const fits = 1 + Math.floor((budget.left - MERGE_ATTEMPT_BASE) / MERGE_COPY_STATEMENTS);

        if (fits < 2) {
            return "budget";
        }

        const [guest, own] = await Promise.all([
            ctx.db.threadAccess.findMany({ consistency: "primary", limit: fits + 1, where: { threadId, userId: from } }),
            ctx.db.threadAccess.findMany({ consistency: "primary", limit: fits + 1, where: { threadId, userId: to } }),
        ]);

        budget.left -= 2;

        const guestCopies = storedRows(guest.page);
        const ownCopies = storedRows(own.page);

        if (guestCopies.length + ownCopies.length === 0 || (guestCopies.length === 0 && ownCopies.length === 1)) {
            return "done";
        }

        // The last stage takes every copy; a part takes the new account's first, so a guest's row stays out of it (the
        // new account's alone cannot fill a part without leaving every guest's row out).
        const last = guestCopies.length + ownCopies.length <= fits;
        const copies = [...ownCopies, ...guestCopies].slice(0, fits);
        // Never a stamped copy (a removal that stopped short of its delete, or this merge's own mark left by a stage that
        // died): writing the kept revision on it would give back a grant that was taken away. Stamped copies only go.
        const live = copies.filter((copy) => !isTombstone(copy.revision));

        if (live.length === 0) {
            for (const copy of copies) {
                await ctx.db.delete("threadAccess", copy._id);
                budget.left -= WRITE_STATEMENTS;
            }

            continue;
        }

        let kept = live[0]!;

        for (const copy of live) {
            if (givesMore(copy, kept, ctx.now)) {
                kept = copy;
            }
        }

        // Past every copy's revision: a change to a guest's copy after the revision merge claimed under the guest's count.
        const revision = await advanceGrantRevision(ctx, {
            current: Math.max(...copies.map((copy) => grantRowRevision(copy.revision))),
            ownerId: kept.ownerId,
            threadId,
            userId: to,
        });
        const deleting = tombstone(revision);
        // The guest's copies last: while one is left, the next page finds the chat.
        const others = copies.filter((copy) => copy._id !== kept._id).toSorted((a, b) => Number(a.userId === from) - Number(b.userId === from));
        const marked: Id<"threadAccess">[] = [];
        /** Puts back the tombstone of every copy still marked: a stage that stops short leaves each a grant to change. */
        const restore = async (): Promise<void> => {
            for (const id of marked) {
                await ctx.db.patchIf("threadAccess", id, { patch: { revision }, where: { revision: deleting } });
                budget.left -= WRITE_STATEMENTS;
            }
        };

        budget.left -= CLAIM_STATEMENTS;

        let raced = false;

        for (const other of others) {
            const mark = await ctx.db.patchIf("threadAccess", other._id, { patch: { revision: deleting }, where: { revision: other.revision ?? null } });

            budget.left -= WRITE_STATEMENTS;

            if (!mark.applied) {
                raced = true;
                break;
            }

            marked.push(other._id);
        }

        if (!raced) {
            const keptWrite = await ctx.db.patchIf("threadAccess", kept._id, { patch: { revision }, where: { revision: kept.revision ?? null } });

            budget.left -= WRITE_STATEMENTS;
            raced = !keptWrite.applied;
        }

        while (!raced && marked.length > 0) {
            // A removal of the kept row since its write: the copies left stay, and the next attempt chooses among them.
            const still = storedRow(await ctx.db.threadAccess.findFirst({ consistency: "primary", where: { _id: kept._id } }));

            budget.left -= 1;

            if (still?.userId !== kept.userId) {
                raced = true;
                break;
            }

            await ctx.db.delete("threadAccess", marked.shift()!);
            budget.left -= WRITE_STATEMENTS;
        }

        if (raced) {
            await restore();
            misses += 1;
            continue;
        }

        // A part done: fewer copies are left, and the next stage reads them again.
        if (!last) {
            misses = 0;
            continue;
        }

        if (kept.userId !== to) {
            const move = await ctx.db.patchIf("threadAccess", kept._id, { patch: { userId: to }, where: { revision } });

            budget.left -= WRITE_STATEMENTS;

            if (!move.applied) {
                misses += 1;
                continue;
            }
        }

        await settleGrant(ctx, threadId, to);
        budget.left -= 2;

        return "done";
    }

    return "raced";
};

/**
 * Moves a merged guest's thread grants to the new account, after their revisions ({@link mergeGrantRevisionsPage}),
 * within `budget` statements: `statements` used, and `done` when the guest holds none. Each chat keeps one grant, the
 * one that gives more ({@link mergeChatGrants}), at a revision claimed past the merged count, so no grant row the new
 * account holds is below the count a denial names. A chat with more copies than a call pays for is merged over several
 * calls, and one whose grants kept changing under the merge is left for the next page.
 */
export const mergeGrantsPage = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    from: string,
    to: string,
    budget: number,
): Promise<{ done: boolean; statements: number }> => {
    // The page read is one of the budget's statements.
    const left = { left: budget - 1 };
    const limit = Math.max(1, Math.floor(left.left / (MERGE_ATTEMPT_BASE + MERGE_COPY_STATEMENTS)));
    const { page } = await ctx.db.threadAccess.findMany({ consistency: "primary", limit: limit + 1, where: { userId: from } });
    const chats = [...new Set(storedRows(page.slice(0, limit)).map((row) => row.threadId))];

    for (const threadId of chats) {
        if ((await mergeChatGrants(ctx, threadId, from, to, left)) !== "done") {
            return { done: false, statements: budget - left.left };
        }
    }

    return { done: page.length <= limit, statements: budget - left.left };
};

/**
 * Statements one guest count's merge plans for, uncontended: the new account's count read and raised, the guest's count
 * marked and deleted (or moved), a claim past both (`past`), and the settle ({@link SETTLE_STATEMENTS}).
 */
const MERGE_REVISION_STATEMENTS = 1 + 3 * WRITE_STATEMENTS + CLAIM_STATEMENTS + SETTLE_STATEMENTS;

/**
 * Folds one guest count into the new account's, every write conditional on the count read: a claim racing the merge
 * under either account makes it miss, and it reads again, so the new account's count never goes back below a revision
 * a claim handed out. There is no conditional delete on a `.global()` table, so the guest's count is first marked with
 * the tombstone of the revision read ({@link tombstone}), conditional on it: a claim that read the count before
 * makes its write miss, and one that reads the mark claims under the new account past it ({@link advanceGrantRevision}),
 * so none lands between the mark and the delete. A newer revision a claim took before the mark makes the mark miss, and
 * the fold reads it again and carries it over. A fold that stops short leaves the mark, which the next one takes up.
 */
const mergeGrantRevision = async (
    ctx: Pick<MutationCtx, "db">,
    row: { _id: Id<"threadAccessRevisions">; revision: number; threadId: Id<"threads"> },
    to: string,
): Promise<void> => {
    let guest = { ...row, revision: grantRowRevision(row.revision) };
    let marked = isTombstone(row.revision);

    for (let attempt = 0; attempt < ADVANCE_ATTEMPTS; attempt += 1) {
        const kept = storedRow(await ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { threadId: guest.threadId, userId: to } }));

        // Another fold moved this very count to the new account since it was read: nothing is left to fold.
        if (kept?._id === guest._id) {
            return;
        }

        let raced: boolean;

        if (kept) {
            const mark = marked
                ? { applied: true }
                : await ctx.db.patchIf("threadAccessRevisions", guest._id, {
                      patch: { revision: tombstone(guest.revision) },
                      where: { revision: guest.revision },
                  });

            marked ||= mark.applied;

            if (mark.applied) {
                const raise =
                    guest.revision > kept.revision
                        ? await ctx.db.patchIf("threadAccessRevisions", kept._id, { patch: { revision: guest.revision }, where: { revision: kept.revision } })
                        : { applied: true };

                if (!raise.applied) {
                    // A claim under the new account moved its count since the read: read it again.
                    continue;
                }

                // Marked: no claim writes this count any more, so the delete loses none.
                await ctx.db.delete("threadAccessRevisions", guest._id);

                return;
            }

            raced = true;
        } else {
            raced = false;

            try {
                // Puts back the revision a mark stands for: the count is the new account's from here.
                const move = await ctx.db.patchIf("threadAccessRevisions", guest._id, {
                    patch: { revision: guest.revision, userId: to },
                    where: { revision: marked ? tombstone(guest.revision) : guest.revision },
                });

                if (move.applied) {
                    return;
                }

                raced = true;
            } catch (error: unknown) {
                // A claim made the new account's count first (the key is unique): read it and fold into it.
                if (!isUniqueViolation(error)) {
                    throw error;
                }
            }
        }

        if (!raced) {
            continue;
        }

        // A claim under the guest since the read: fold in the count it took.
        const again = storedRow(await ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { _id: guest._id } }));

        if (!again) {
            return;
        }

        guest = { ...again, revision: grantRowRevision(again.revision) };
        marked = isTombstone(again.revision);
    }

    throw new LunoraError("CONFLICT", "The chat's sharing changed at the same moment. Try again.");
};

/**
 * Moves a page of a merged guest's grant revisions (those of grants they held) to the new account, sized to stay within
 * `budget` statements ({@link GRANT_PAGE_STATEMENTS} by default): `moved`, and `done` when none is left. Where the new account already has a count for the
 * thread (it was granted it too), the higher count is kept on the new account's row and the guest's goes: the key is
 * unique ({@link mergeGrantRevision}). Rows the guest owns as the chat's owner are re-pointed after these
 * ({@link reassignOwnedRevisionsPage}). A grant the new account holds is then settled past the merged count: the guest
 * may hold a count for a chat without a grant (a removal), which a denial named.
 */
export const mergeGrantRevisionsPage = async (
    ctx: Pick<MutationCtx, "db">,
    from: string,
    to: string,
    { budget = GRANT_PAGE_STATEMENTS, past = false }: { budget?: number; past?: boolean } = {},
): Promise<{ done: boolean; moved: number }> => {
    const limit = Math.max(1, Math.floor((budget - 1) / MERGE_REVISION_STATEMENTS));
    const { page } = await ctx.db.threadAccessRevisions.findMany({ consistency: "primary", limit: limit + 1, where: { userId: from } });
    const rows = storedRows(page.slice(0, limit));

    for (const row of rows) {
        await foldGuestRevision(ctx, row, to, past);
    }

    return { done: page.length <= limit, moved: rows.length };
};

/**
 * Folds one guest count into account `to`'s ({@link mergeGrantRevision}) and settles `to`'s grant past it. `past` for a
 * count the guest took after the grants moved: a removal that read the grant before the merge moved it, whose last
 * revision may equal the moved grant's. It is then advanced past both, so a denial names a revision no grant row held.
 */
const foldGuestRevision = async (
    ctx: Pick<MutationCtx, "db">,
    row: { _id: Id<"threadAccessRevisions">; ownerId?: string; revision: number; threadId: Id<"threads"> },
    to: string,
    past: boolean,
): Promise<void> => {
    await mergeGrantRevision(ctx, row, to);

    if (past) {
        await advanceGrantRevision(ctx, { ownerId: row.ownerId, threadId: row.threadId, userId: to });
    }

    await settleGrant(ctx, row.threadId, to);
};

/**
 * Re-points the counts on chats merged guest `from` owns (`ownerId`) to `to`, within `budget` statements: the page read,
 * then a patch per row, which on a `.global()` table reads its row before it writes ({@link WRITE_STATEMENTS}). No key
 * constrains `ownerId`, so a row is patched as is: `moved`, and `done` when none is left.
 */
export const reassignOwnedRevisionsPage = async (
    ctx: Pick<MutationCtx, "db">,
    from: string,
    to: string,
    budget: number,
): Promise<{ done: boolean; moved: number }> => {
    const limit = Math.max(1, Math.floor((budget - 1) / WRITE_STATEMENTS));
    const { page } = await ctx.db.threadAccessRevisions.findMany({ consistency: "primary", limit: limit + 1, where: { ownerId: from } });
    const rows = storedRows(page.slice(0, limit));

    for (const row of rows) {
        await ctx.db.patch("threadAccessRevisions", row._id, { ownerId: to });
    }

    return { done: page.length <= limit, moved: rows.length };
};

/**
 * Whether a thread grant or a grant revision still names guest `userId`, as its grantee or its chat's owner, read from
 * the primary: the merge's last check before it deletes the guest (`auth/hooks.ts#deleteMergedGuest`), so a row it
 * missed fails the job, and the redelivery moves it.
 */
export const guestHoldsGrantRows = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const rows = await Promise.all([
        ctx.db.threadAccess.findFirst({ consistency: "primary", where: { userId } }),
        ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { userId } }),
        ctx.db.threadAccess.findFirst({ consistency: "primary", where: { ownerId: userId } }),
        ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { ownerId: userId } }),
    ]);

    return rows.some((row) => row !== null);
};
