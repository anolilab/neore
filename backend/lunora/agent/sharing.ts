import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx as QueryContext } from "../_generated/server";

/**
 * Thread access and invite operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { followupDispatchInFlight } from "./followup-suggestions";
import { assert } from "../lib/error-helpers";
import { withoutUndefined } from "../lib/patch";
import { storedRow, storedRows } from "../lib/stored-row";
import { isThreadLocked } from "../lib/thread-lock";
import { meetsThreadPermission, resolveThreadReadAccess, type ThreadPermission } from "./thread-read-access";

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
                threadId: v.id("threads"),
                userId: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => storedRow(await ctx.db.threadAccess.findFirst({ where: { threadId: args.threadId, userId: args.userId } })));

/**
 * The owner of `threadId` when `userId` holds an unexpired grant on it — the
 * shard a grantee's thread-scoped work must run on.
 * `null` when there is no grant, which for
 * the owner themself is the normal answer.
 *
 * `threadAccess` is `.global()`, so this answers from any shard.
 */
export const grantOwnerForThread = async (context: Pick<QueryContext, "db">, threadId: string, userId: string): Promise<string | null> => {
    const grant = storedRow(await context.db.threadAccess.findFirst({ where: { threadId: threadId as Id<"threads">, userId } }));

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

    return storedRows(page);
};

/** A thread's invites (`.global()`), oldest first. */
const loadThreadInvites = async (context: Pick<QueryContext, "db">, threadId: Id<"threads">) => {
    const { page } = await context.db.threadInvites.findMany({ limit: 100, orderBy: [{ _creationTime: "asc" }], where: { threadId } });

    return storedRows(page);
};

export const createThreadAccess = internalMutation
    .input({
        expiresAt: v.optional(v.number()),
        grantedBy: v.string(),
        /** The thread's owner: the shard the grantee is admitted to. */
        ownerId: v.string(),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.id("threadAccess"))
    .mutation(async ({ args, ctx }) => {
        await refuseGrantOnLockedThread(ctx, args.threadId);

        const insertedId = await ctx.db.insert("threadAccess", {
            expiresAt: args.expiresAt,
            grantedAt: ctx.now,
            grantedBy: args.grantedBy,
            ownerId: args.ownerId,
            permission: args.permission,
            threadId: args.threadId,
            userId: args.userId,
        });

        return insertedId as Id<"threadAccess">;
    });

export const updateThreadAccess = internalMutation
    .input({
        accessId: v.id("threadAccess"),
        expiresAt: v.optional(v.number()),
        permission: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const access = await ctx.db.threadAccess.findFirst({ where: { _id: args.accessId } });

        assert(access, `Thread access ${args.accessId} not found`);

        const patch: { expiresAt?: number; permission?: ThreadPermission } = {};

        if (args.permission !== undefined) {
            patch.permission = args.permission;
        }

        if (args.expiresAt !== undefined) {
            patch.expiresAt = args.expiresAt;
        }

        await ctx.db.patch("threadAccess", args.accessId, withoutUndefined(patch));

        return null;
    });

/** Grants and invites one `revokeThreadGrantsJob` run removes: each is one D1 statement, under a Worker invocation's cap. */
const REVOKE_BATCH = 40;

/**
 * Removes up to `limit` of a thread's share grants, then revokes its pending invites within what is left; `true` when
 * none of either is left. Primary reads: a replica that lags a fresh grant would leave it behind.
 */
const revokeThreadGrantsPage = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, limit: number): Promise<boolean> => {
    const grants = await ctx.db.threadAccess.findMany({ consistency: "primary", limit: limit + 1, where: { threadId } });

    for (const grant of grants.page.slice(0, limit)) {
        await ctx.db.delete("threadAccess", grant._id);
    }

    const room = limit - Math.min(grants.page.length, limit);

    if (grants.page.length > limit || room === 0) {
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
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        if (!(await revokeThreadGrantsPage(ctx, args.threadId, REVOKE_BATCH))) {
            await ctx.scheduler.runAfter(0, internal.agent.sharing.revokeThreadGrantsJob, args);
        }

        return null;
    });

/** Starts revoking a deleted thread's share grants and pending invites ({@link revokeThreadGrantsJob}). */
export const revokeThreadGrants = async (ctx: Pick<MutationCtx, "scheduler">, threadId: Id<"threads">): Promise<void> => {
    await ctx.scheduler.runAfter(0, internal.agent.sharing.revokeThreadGrantsJob, { threadId });
};

export const deleteThreadAccess = internalMutation
    .input({
        accessId: v.id("threadAccess"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const access = await ctx.db.threadAccess.findFirst({ where: { _id: args.accessId } });

        // A suggestion job takes its dispatch claim before it reads the grant, so a claim held here refuses the removal (kept for a retry).
        // The grant is a global row and the claim is shard-local, so this check and the delete are not one transaction: a claim that
        // starts just after the check is not refused. That window is the known limit recorded on the PR.
        if (access && (await followupDispatchInFlight(ctx, access.threadId))) {
            throw new LunoraError("CONFLICT", "A suggestion is being generated for this chat. Try again in a moment.");
        }

        await ctx.db.delete("threadAccess", args.accessId);

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
