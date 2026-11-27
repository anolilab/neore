import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { refuseWhileWaking } from "../source-control/pr-watch-wake-lease";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx as QueryContext } from "../_generated/server";

/**
 * Thread access and invite operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { assert } from "../lib/error-helpers";
import { withoutUndefined } from "../lib/patch";
import { storedRow, storedRows } from "../lib/stored-row";
import { mergedGuestTarget } from "../lib/shard-routes";
import { isThreadLocked } from "../lib/thread-lock";
import {
    advanceGrantRevision,
    GRANT_PAGE_STATEMENTS,
    isThreadPurged,
    markThreadPurged,
    PURGE_MARK_TTL_MS,
    REMOVE_GRANT_STATEMENTS,
    removeGrant,
    settleGrant,
    throwThreadPurged,
    WRITE_STATEMENTS,
    writeGrant,
    writeGrantOver,
} from "./grant-revision";
import { meetsThreadPermission, resolveThreadReadAccess, type ThreadPermission } from "./thread-read-access";
import { findLiveGrant, GRANT_COPIES_SCANNED, isTombstonedGrant } from "./live-grant";

/**
 * A locked chat is owner-only and is not shared: no grant or invite is written for it.
 * Read through `ctx.db`: these are internal mutations, which see every row.
 */
const refuseGrantOnLockedThread = async (ctx: Pick<QueryContext, "db">, threadId: Id<"threads">): Promise<void> => {
    const thread = await ctx.db.get("threads", threadId);

    if (thread && isThreadLocked(thread)) {
        throw new LunoraError("BAD_REQUEST", "A locked chat cannot be shared. Unlock it first.");
    }
};

/**
 * A guest whose account merge has started takes no new grant: the merge moves the guest's grants once, so one written
 * after it read them would stay on the guest. Its new account accepts the invite instead.
 */
const refuseGrantToMergedGuest = async (ctx: Pick<QueryContext, "db">, userId: string): Promise<void> => {
    if ((await mergedGuestTarget(ctx, userId)) !== null) {
        throw new LunoraError("CONFLICT", "This guest session has moved to a signed-in account. Sign in to that account and open the invite again.");
    }
};

/**
 * A chat whose owner is a merging guest is refused a grant until the merge has re-pointed its invite: until then the
 * chat may sit on either shard, and the invitee would be sent to the guest's, which the merge empties.
 */
export const refuseGrantOnMergingOwner = async (ctx: Pick<QueryContext, "db">, ownerId: string): Promise<void> => {
    if ((await mergedGuestTarget(ctx, ownerId)) !== null) {
        throwOwnerMerging();
    }
};

/** The refusal {@link refuseGrantOnMergingOwner} throws, for a caller that already saw the owner's merge mark. */
export const throwOwnerMerging = (): never => {
    throw new LunoraError("CONFLICT", "This chat is moving to its owner's signed-in account. Open the invite again in a minute.");
};

/** Whether account `userId` still exists, read from the primary: a merged guest's is deleted before its mark goes. */
const accountExists = async (ctx: Pick<QueryContext, "db">, userId: string): Promise<boolean> =>
    (await ctx.db.user.findFirst({ consistency: "primary", where: { _id: ctx.db.asId("user", userId) } })) !== null;

/**
 * A grant whose grantee or chat owner has no account is refused: a merged guest's mark goes once the guest is deleted
 * (`auth/hooks.ts#deleteMergedGuest`), and a token issued before that still names the guest.
 */
const refuseGrantWithoutAccounts = async (ctx: Pick<QueryContext, "db">, userId: string, ownerId: string): Promise<void> => {
    const [grantee, owner] = await Promise.all([accountExists(ctx, userId), accountExists(ctx, ownerId)]);

    if (!grantee || !owner) {
        throw new LunoraError("CONFLICT", "This account has moved to a signed-in account. Sign in to that account and open the invite again.");
    }
};

// Thread Access Functions — internal only; use chat/sharing.ts for auth-gated client APIs
export const getThreadAccess = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(
        v.union(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadAccess"),
                expiresAt: v.optional(v.number()),
                grantedAt: v.number(),
                grantedBy: v.string(),
                ownerId: v.optional(v.string()),
                permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
                revision: v.optional(v.number()),
                threadId: v.id("threads"),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => await findLiveGrant(ctx, args.threadId, args.userId));

/**
 * The owner of `threadId` when `userId` holds an unexpired grant on it — the
 * shard a grantee's thread-scoped work must run on.
 * `null` when there is no grant, which for
 * the owner themself is the normal answer.
 *
 * `threadAccess` is `.global()`, so this answers from any shard.
 */
export const grantOwnerForThread = async (context: Pick<QueryContext, "db">, threadId: string, userId: string): Promise<string | null> => {
    const grant = await findLiveGrant(context, threadId as Id<"threads">, userId);

    if (!grant?.ownerId || (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())) {
        return null;
    }

    return grant.ownerId;
};

export const getGrantOwner = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await grantOwnerForThread(ctx, args.threadId, args.userId));

const vListThreadAccessOutput = v.array(
    v.object({
        _creationTime: v.number(),
        _id: v.id("threadAccess"),
        expiresAt: v.optional(v.number()),
        grantedAt: v.number(),
        grantedBy: v.string(),
        ownerId: v.optional(v.string()),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        revision: v.optional(v.number()),
        threadId: v.id("threads"),
        userId: v.string(),
    }),
);

export const listThreadAccess = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.from(vListThreadAccessOutput))
    .query(async ({ args, ctx }): Promise<Infer<typeof vListThreadAccessOutput>> => listThreadAccessHandler(ctx, args));

/**
 * Direct handler for listing thread access entries.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const listThreadAccessHandler = async (context: QueryContext, args: { threadId: Id<"threads"> }) => {
    const { page } = await context.db.threadAccess.findMany({ limit: 100, orderBy: [{ userId: "asc" }], where: { threadId: args.threadId } });

    // A copy being deleted (a removal that stopped part way) is no one's access any more.
    return storedRows(page).filter((grant) => !isTombstonedGrant(grant));
};

/** A thread's invites (`.global()`), oldest first. */
const loadThreadInvites = async (context: Pick<QueryContext, "db">, threadId: Id<"threads">) => {
    const { page } = await context.db.threadInvites.findMany({ limit: 100, orderBy: [{ _creationTime: "asc" }], where: { threadId } });

    return storedRows(page);
};

/** The highest revision a grant copy of `userId` on `threadId` stands for (a tombstone reads as the revision it marks), or `null` with none left. */
const survivingCopyRevision = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, userId: string): Promise<number | null> => {
    const { page } = await ctx.db.threadAccess.findMany({ consistency: "primary", limit: GRANT_COPIES_SCANNED, where: { threadId, userId } });

    return page.length === 0 ? null : Math.max(...storedRows(page).map((copy) => Math.abs(copy.revision ?? 0)));
};

/**
 * Drops a grant written for an account or a chat that is gone, and the grantee's count to the chat once no copy of the
 * grant is left: no denial names it again. A copy that survives keeps the count, which fences its later removal.
 *
 * There is no conditional delete on a `.global()` table, so the copies are read again after the count's delete: a copy
 * written between the first read and the delete (its claim read the count before it went) gets a count past its revision
 * back, so no surviving copy is left without the count that orders its later removal. A copy whose insert lands after
 * that second read went through the same accept and its checks, so it finds the same account or chat gone and drops itself.
 */
const purgeGrantOfDeletedAccount = async (
    ctx: Pick<MutationCtx, "db">,
    grantId: Id<"threadAccess">,
    threadId: Id<"threads">,
    userId: string,
): Promise<void> => {
    await ctx.db.delete("threadAccess", grantId);

    if ((await survivingCopyRevision(ctx, threadId, userId)) !== null) {
        return;
    }

    const counter = storedRow(await ctx.db.threadAccessRevisions.findFirst({ consistency: "primary", where: { threadId, userId } }));

    if (!counter) {
        return;
    }

    await ctx.db.delete("threadAccessRevisions", counter._id);

    const raced = await survivingCopyRevision(ctx, threadId, userId);

    if (raced !== null) {
        await advanceGrantRevision(ctx, { current: Math.max(raced, Math.abs(counter.revision)), ownerId: counter.ownerId, threadId, userId });
    }
};

/**
 * Deletes the copies of a grant a removal stamped and then stopped short of deleting (`grant-revision.ts#removeGrant`):
 * they grant nothing (`live-grant.ts`), and the grant written beside them now stands for the grantee's access. No write
 * takes a stamped row, so a plain delete loses nothing; a removal still running finds the row gone and is done.
 */
const clearTombstonedCopies = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, userId: string, keep: Id<"threadAccess">): Promise<void> => {
    const { page } = await ctx.db.threadAccess.findMany({ consistency: "primary", limit: GRANT_COPIES_SCANNED, where: { threadId, userId } });

    for (const copy of storedRows(page)) {
        if (copy._id !== keep && isTombstonedGrant(copy)) {
            await ctx.db.delete("threadAccess", copy._id);
        }
    }
};

/**
 * Writes a new grant of `threadId` to `userId` under a newly claimed revision. A plain function, so a test can watch
 * what a refused grant leaves behind (a throwing mutation's writes are rolled back in the test harness, not on D1).
 */
export const insertThreadAccess = async (
    ctx: MutationCtx,
    args: {
        expiresAt?: number;
        grantedBy: string;
        ownerId: string;
        permission: ThreadPermission;
        /** Both grantee and owner must have an account (an invite accepted by a signed-in caller). */
        requireAccounts?: boolean;
        threadId: Id<"threads">;
        userId: string;
    },
): Promise<{ accessId: Id<"threadAccess">; revision: number }> => {
    await refuseGrantOnLockedThread(ctx, args.threadId);
    // A pull request watch is writing to this chat: no new reader until it is done (`source-control/pr-watch-wake-lease.ts`).
    await refuseWhileWaking(ctx, args.ownerId, args.threadId);
    await refuseGrantToMergedGuest(ctx, args.userId);
    await refuseGrantOnMergingOwner(ctx, args.ownerId);

    if (args.requireAccounts === true) {
        await refuseGrantWithoutAccounts(ctx, args.userId, args.ownerId);
    }

    const { ownerId } = args;
    const revision = await advanceGrantRevision(ctx, { ownerId, threadId: args.threadId, userId: args.userId });
    // lunora-advisor-exempt owner_field_from_args_not_auth -- a helper, not a procedure: its one caller, the internal `createThreadAccess`, is called only by `acceptThreadInvite`, which passes the session's `ctx.user.userId` as `userId` and the stored invite's `ownerId`, never request input
    const insertedId = (await ctx.db.insert("threadAccess", {
        expiresAt: args.expiresAt,
        grantedAt: ctx.now,
        grantedBy: args.grantedBy,
        ownerId,
        permission: args.permission,
        revision,
        threadId: args.threadId,
        userId: args.userId,
    })) as Id<"threadAccess">;

    // The chat was deleted for good after the invite was read (its purge marks it before it reads a grant): the purge
    // may have read its grants already, so this one and its count go again. A purge marked after this read finds both.
    if (await isThreadPurged(ctx, args.threadId)) {
        await purgeGrantOfDeletedAccount(ctx, insertedId, args.threadId, args.userId);
        throwThreadPurged();
    }

    // A removal racing this grant may have advanced past the revision claimed above.
    const settledRevisions = await settleGrant(ctx, args.threadId, args.userId);
    const settled = settledRevisions.get(insertedId) ?? revision;

    // The grantee's or the owner's account merge started since the checks above, and may have read the guest's grants
    // before this one: removed again rather than left naming the guest (a lost race lowers access, never raises it).
    const [grantee, owner] = await Promise.all([mergedGuestTarget(ctx, args.userId), mergedGuestTarget(ctx, ownerId)]);

    if (grantee !== null || owner !== null) {
        await removeGrant(ctx, { _id: insertedId, ownerId, threadId: args.threadId, userId: args.userId });
        await refuseGrantToMergedGuest(ctx, args.userId);

        throw new LunoraError("CONFLICT", "This chat moved to another account while you joined it. Open the invite again.");
    }

    // A merge finished since the checks above: the guest was deleted before its mark went, so one of these reads finds
    // it gone. Its grant and count go with it, as the guest's own deletion would have taken them.
    if (args.requireAccounts === true) {
        const [granteeExists, ownerExists] = await Promise.all([accountExists(ctx, args.userId), accountExists(ctx, ownerId)]);

        if (!granteeExists || !ownerExists) {
            await purgeGrantOfDeletedAccount(ctx, insertedId, args.threadId, args.userId);
            await refuseGrantWithoutAccounts(ctx, args.userId, ownerId);
        }
    }

    await clearTombstonedCopies(ctx, args.threadId, args.userId, insertedId);

    // The revision this grant was written at: an accept's undo (`undoInviteGrant`) takes back only that state.
    return { accessId: insertedId, revision: settled };
};

export const createThreadAccess = internalMutation
    .input({
        expiresAt: v.optional(v.number()),
        grantedBy: v.string(),
        /** The thread's owner: the shard the grantee is admitted to. */
        ownerId: v.string(),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        /** Refused unless grantee and owner both have an account. */
        requireAccounts: v.optional(v.boolean()),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.object({ accessId: v.id("threadAccess"), revision: v.number() }))
    .mutation(async ({ args, ctx }) => await insertThreadAccess(ctx, args));

export const updateThreadAccess = internalMutation
    .input({
        accessId: v.id("threadAccess"),
        expiresAt: v.optional(v.number()),
        permission: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
    })
    // The revision the change was written at.
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        // Conditional on the revision it read, claimed again on a lost race: a concurrent change never ends up older.
        const written = await writeGrant(ctx, args.accessId, {
            ...(args.expiresAt !== undefined && { expiresAt: args.expiresAt }),
            ...(args.permission !== undefined && { permission: args.permission }),
        });

        assert(written !== false, `Thread access ${args.accessId} not found`);

        return written;
    });

/**
 * Raises grant `accessId` to an invite's `permission` (`chat/sharing.ts#acceptThreadInvite`), decided on the row the
 * conditional write replaces: `kept` when that row already gives as much (an invite never lowers a role, and a change
 * since the accept's read is kept), else the role it replaced and the revision written, which an undo restores.
 */
export const raiseInviteGrant = internalMutation
    .input({ accessId: v.id("threadAccess"), permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")) })
    .output(
        v.union(
            v.object({ kind: v.literal("kept"), permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")) }),
            v.object({ kind: v.literal("raised"), previous: v.union(v.literal("read"), v.literal("write"), v.literal("admin")), revision: v.number() }),
        ),
    )
    .mutation(async ({ args, ctx }) => {
        let kept: ThreadPermission | undefined;
        const written = await writeGrantOver(ctx, args.accessId, (grant) => {
            kept = meetsThreadPermission(grant.permission, args.permission) ? grant.permission : undefined;

            return kept === undefined ? { permission: args.permission } : null;
        });

        assert(written !== false, `Thread access ${args.accessId} not found`);

        return written === null
            ? { kind: "kept" as const, permission: kept ?? args.permission }
            : { kind: "raised" as const, previous: written.replaced.permission, revision: written.revision };
    });

/**
 * Takes back what an invite's accept wrote to grant `accessId` (`chat/sharing.ts#acceptThreadInvite`), when the chat's
 * owner was marked as merging after the write: the grant it created is removed, a role it raised goes back to
 * `previous`. Only while the row still holds the `revision` the accept wrote: the removal's stamp and the restore are
 * conditional on it, so a write since (an administrator's change, any grant write) is someone else's and is kept.
 */
export const undoInviteGrant = internalMutation
    .input({
        accessId: v.id("threadAccess"),
        /** The role the grant had before the accept; absent when the accept created the grant. */
        previous: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
        /** The revision the accept's write left on the grant. */
        revision: v.number(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const grant = storedRow(await ctx.db.threadAccess.findFirst({ consistency: "primary", where: { _id: args.accessId } }));

        if (!grant) {
            return null;
        }

        if (args.previous === undefined) {
            await removeGrant(ctx, grant, { expected: args.revision });
        } else {
            // `false`: removed or changed since, which is kept.
            await writeGrant(ctx, args.accessId, { permission: args.previous }, { expected: args.revision });
        }

        return null;
    });

/**
 * Removes a page of a thread's share grants, then (`purge`) its grant revisions, then revokes its pending invites, within
 * {@link GRANT_PAGE_STATEMENTS} of the invocation's D1 queries: each page read is one, a removal
 * {@link REMOVE_GRANT_STATEMENTS}, a purged grant, a revision or an invite {@link WRITE_STATEMENTS}. `true` when none of them is left. A
 * trashed chat's grants advance their revisions as any removal does, so a grant given again after a restore continues
 * past them; a chat deleted for good keeps none: its status answers no one by a grant again. A purge first marks the
 * chat ({@link markThreadPurged}), so a grant or a count written after its reads takes itself back. Primary reads: a
 * replica that lags a fresh grant would leave it behind.
 */
export const revokeThreadGrantsPage = async (ctx: Pick<MutationCtx, "db" | "now">, threadId: Id<"threads">, purge: boolean): Promise<boolean> => {
    const cost = purge ? WRITE_STATEMENTS : REMOVE_GRANT_STATEMENTS;
    // Less the grants' read, and one statement kept for the next read.
    let left = GRANT_PAGE_STATEMENTS - 1;

    if (purge) {
        // Before any read below: a write that misses the mark landed before it, so those reads find it.
        await markThreadPurged(ctx, threadId);
        left -= 2;
    }

    const limit = Math.max(1, Math.floor((left - 1) / cost));
    const grants = await ctx.db.threadAccess.findMany({ consistency: "primary", limit: limit + 1, where: { threadId } });
    const removed = storedRows(grants.page.slice(0, limit));

    for (const grant of removed) {
        if (purge) {
            await ctx.db.delete("threadAccess", grant._id);
        } else {
            await removeGrant(ctx, grant);
        }

        left -= cost;
    }

    if (grants.page.length > limit) {
        return false;
    }

    if (purge) {
        // Less this read, and one kept for the invites'.
        const room = Math.floor((left - 2) / WRITE_STATEMENTS);

        if (room < 1) {
            return false;
        }

        const revisions = await ctx.db.threadAccessRevisions.findMany({ consistency: "primary", limit: room + 1, where: { threadId } });

        for (const row of revisions.page.slice(0, room)) {
            await ctx.db.delete("threadAccessRevisions", row._id);
        }

        if (revisions.page.length > room) {
            return false;
        }

        left -= 1 + WRITE_STATEMENTS * revisions.page.length;
    }

    const room = Math.floor((left - 1) / WRITE_STATEMENTS);

    if (room < 1) {
        return false;
    }

    const invites = await ctx.db.threadInvites.findMany({ consistency: "primary", limit: room + 1, where: { status: "pending", threadId } });

    for (const invite of invites.page.slice(0, room)) {
        await ctx.db.patch("threadInvites", invite._id, { status: "revoked" });
    }

    return invites.page.length <= room;
};

/**
 * Removes every share grant of a deleted thread and revokes its pending invites, a batch at a time, so no collaborator
 * keeps reading it, or a memory's quote from it (`memory/functions.ts#getMemorySource`, which sees only the grant), and
 * no invite redeemed later grants it again. Scheduled by the delete (`revokeThreadGrants`) rather than run inside it, so
 * a widely shared chat never takes the delete past the statement cap. A chat restored from the trash is shared again by
 * hand.
 */
export const revokeThreadGrantsJob = internalMutation
    .input({ purge: v.optional(v.boolean()), threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        if (!(await revokeThreadGrantsPage(ctx, args.threadId, args.purge === true))) {
            await ctx.scheduler.runAfter(0, internal.agent.sharing.revokeThreadGrantsJob, args);
        } else if (args.purge === true) {
            await ctx.scheduler.runAfter(PURGE_MARK_TTL_MS, internal.agent.sharing.dropThreadPurgeMark, { threadId: args.threadId });
        }

        return null;
    });

/**
 * Drops a purged chat's mark ({@link markThreadPurged}) a day after its purge finished: by then no write that read the
 * chat's invite or grants before the purge is still running, so the marks do not grow with every chat deleted. One a
 * lost job leaves names no user.
 */
export const dropThreadPurgeMark = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const mark = await ctx.db.threadPurgeMarks.findFirst({ consistency: "primary", where: { threadId: args.threadId } });

        if (mark) {
            await ctx.db.delete("threadPurgeMarks", mark._id);
        }

        return null;
    });

/**
 * Starts revoking a deleted thread's share grants and pending invites ({@link revokeThreadGrantsJob}); `purge` for a chat
 * deleted for good, whose grant revisions go too.
 */
export const revokeThreadGrants = async (ctx: Pick<MutationCtx, "scheduler">, threadId: Id<"threads">, options: { purge?: boolean } = {}): Promise<void> => {
    await ctx.scheduler.runAfter(0, internal.agent.sharing.revokeThreadGrantsJob, { ...(options.purge === true && { purge: true }), threadId });
};

export const deleteThreadAccess = internalMutation
    .input({
        accessId: v.id("threadAccess"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // Run only under the chat's revoke hold (`holdFollowupRevoke`, in `chat/sharing.ts`): no suggestion request starts on the chat
        // until the hold is released, so this delete is not raced by one.
        const grant = storedRow(await ctx.db.threadAccess.findFirst({ consistency: "primary", where: { _id: args.accessId } }));

        if (grant) {
            // The revision outlives the row: a denial after the removal names it, and a later grant continues past it.
            await removeGrant(ctx, grant);
        }

        return null;
    });

// Thread Invite Functions
export const getThreadInvite = internalQuery
    .input({
        inviteToken: v.string(),
    })
    .output(
        v.union(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadInvites"),
                acceptedAt: v.optional(v.number()),
                acceptedBy: v.optional(v.string()),
                expiresAt: v.number(),
                invitedBy: v.string(),
                invitedEmail: v.string(),
                inviteToken: v.string(),
                ownerId: v.optional(v.string()),
                permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
                status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
                threadId: v.id("threads"),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => storedRow(await ctx.db.threadInvites.findFirst({ where: { inviteToken: args.inviteToken } })));

export const getThreadInviteById = internalQuery
    .input({
        inviteId: v.id("threadInvites"),
    })
    .output(
        v.union(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadInvites"),
                acceptedAt: v.optional(v.number()),
                acceptedBy: v.optional(v.string()),
                expiresAt: v.number(),
                invitedBy: v.string(),
                invitedEmail: v.string(),
                inviteToken: v.string(),
                ownerId: v.optional(v.string()),
                permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
                status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
                threadId: v.id("threads"),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => storedRow(await ctx.db.threadInvites.findFirst({ where: { _id: args.inviteId } })));

export const listThreadInvites = internalQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(
        v.array(
            v.object({
                _creationTime: v.number(),
                _id: v.id("threadInvites"),
                acceptedAt: v.optional(v.number()),
                acceptedBy: v.optional(v.string()),
                expiresAt: v.number(),
                invitedBy: v.string(),
                invitedEmail: v.string(),
                inviteToken: v.string(),
                ownerId: v.optional(v.string()),
                permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
                status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
                threadId: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => await loadThreadInvites(ctx, args.threadId));

const vGetThreadInvitesWithAccessCheckOutput = v.union(
    v.array(
        v.object({
            _creationTime: v.number(),
            _id: v.id("threadInvites"),
            acceptedAt: v.optional(v.number()),
            acceptedBy: v.optional(v.string()),
            expiresAt: v.number(),
            invitedBy: v.string(),
            invitedEmail: v.string(),
            inviteToken: v.string(),
            ownerId: v.optional(v.string()),
            permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
            status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
            threadId: v.string(),
        }),
    ),
    v.null(),
);

export const getThreadInvitesWithAccessCheck = internalQuery
    .input({
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.from(vGetThreadInvitesWithAccessCheckOutput))
    .query(async ({ args, ctx }): Promise<Infer<typeof vGetThreadInvitesWithAccessCheckOutput>> => getThreadInvitesWithAccessCheckHandler(ctx, args));

/**
 * Direct handler for thread invites with access check.
 * Exported for hot-path queries to bypass runQuery validator overhead.
 */
export const getThreadInvitesWithAccessCheckHandler = async (
    context: QueryContext,
    args: { threadId: Id<"threads">; unlockProof?: string | null; userId: string },
) => {
    // Pending invites carry their bearer `inviteToken`, and redeeming one grants
    // its permission — so listing them is an ADMIN capability (owner or live
    // admin grant), exactly like `createThreadInvite`. It used to admit any
    // grantee and, via `isPublic`, any signed-in caller, which let a read-only
    // viewer lift a pending admin token and escalate.
    const access = await resolveThreadReadAccess(context, args.threadId, args.userId, args.unlockProof);

    if (access?.kind !== "full" || !meetsThreadPermission(access.permission, "admin")) {
        return null;
    }

    return await loadThreadInvites(context, args.threadId);
};

export const createThreadInvite = internalMutation
    .input({
        expiresAt: v.number(),
        invitedBy: v.string(),
        invitedEmail: v.string(),
        inviteToken: v.string(),
        /** The thread's owner, so the invitee's shard can route to the thread's. */
        ownerId: v.string(),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        threadId: v.id("threads"),
    })
    .output(v.id("threadInvites"))
    .mutation(async ({ args, ctx }) => {
        await refuseGrantOnLockedThread(ctx, args.threadId);

        const insertedId = await ctx.db.insert("threadInvites", {
            expiresAt: args.expiresAt,
            invitedBy: args.invitedBy,
            invitedEmail: args.invitedEmail,
            inviteToken: args.inviteToken,
            ownerId: args.ownerId,
            permission: args.permission,
            status: "pending",
            threadId: args.threadId,
        });

        return insertedId as Id<"threadInvites">;
    });

export const updateThreadInvite = internalMutation
    .input({
        acceptedAt: v.optional(v.number()),
        acceptedBy: v.optional(v.string()),
        inviteId: v.id("threadInvites"),
        status: v.optional(v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked"))),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const invite = await ctx.db.threadInvites.findFirst({ where: { _id: args.inviteId } });

        assert(invite, `Thread invite ${args.inviteId} not found`);

        const patch: { acceptedAt?: number; acceptedBy?: string; status?: "accepted" | "expired" | "pending" | "revoked" } = {};

        if (args.status !== undefined) {
            patch.status = args.status;
        }

        if (args.acceptedAt !== undefined) {
            patch.acceptedAt = args.acceptedAt;
        }

        if (args.acceptedBy !== undefined) {
            patch.acceptedBy = args.acceptedBy;
        }

        await ctx.db.patch("threadInvites", args.inviteId, withoutUndefined(patch));

        return null;
    });

export const deleteThreadInvite = internalMutation
    .input({
        inviteId: v.id("threadInvites"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.delete("threadInvites", args.inviteId);

        return null;
    });
