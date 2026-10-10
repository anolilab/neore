import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx as QueryContext } from "../_generated/server";

/**
 * Thread access and invite operations.
 * Migrated from `@neore/backend-agent` component.
 */
import { assert } from "../lib/error-helpers";
import { meetsThreadPermission, resolveThreadReadAccess, type ThreadPermission } from "./thread-read-access";
import { withoutUndefined } from "../lib/patch";
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
    .query(async ({ args, ctx }) => await ctx.db.threadAccess.findFirst({ where: { threadId: args.threadId, userId: args.userId } }));

/**
 * The owner of `threadId` when `userId` holds an unexpired grant on it — the
 * shard a grantee's thread-scoped work must run on
 * (docs/plans/per-user-sharding.md). `null` when there is no grant, which for
 * the owner themself is the normal answer.
 *
 * `threadAccess` is `.global()`, so this answers from any shard.
 */
export const grantOwnerForThread = async (context: Pick<QueryContext, "db">, threadId: string, userId: string): Promise<string | null> => {
    const grant = await context.db.threadAccess.findFirst({ where: { threadId: threadId as Id<"threads">, userId } });

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

    return page;
};

/** A thread's invites (`.global()`), oldest first. */
const loadThreadInvites = async (context: Pick<QueryContext, "db">, threadId: Id<"threads">) => {
    const { page } = await context.db.threadInvites.findMany({ limit: 100, orderBy: [{ _creationTime: "asc" }], where: { threadId } });

    return page;
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

        await ctx.db.patch(args.accessId, withoutUndefined(patch));

        return null;
    });

export const deleteThreadAccess = internalMutation
    .input({
        accessId: v.id("threadAccess"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.delete(args.accessId);

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
    .query(async ({ args, ctx }) => await ctx.db.threadInvites.findFirst({ where: { inviteToken: args.inviteToken } }));

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
    .query(async ({ args, ctx }) => await ctx.db.threadInvites.findFirst({ where: { _id: args.inviteId } }));

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
export const getThreadInvitesWithAccessCheckHandler = async (context: QueryContext, args: { threadId: Id<"threads">; userId: string }) => {
    // Pending invites carry their bearer `inviteToken`, and redeeming one grants
    // its permission — so listing them is an ADMIN capability (owner or live
    // admin grant), exactly like `createThreadInvite`. It used to admit any
    // grantee and, via `isPublic`, any signed-in caller, which let a read-only
    // viewer lift a pending admin token and escalate.
    const access = await resolveThreadReadAccess(context, args.threadId, args.userId);

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

        await ctx.db.patch(args.inviteId, withoutUndefined(patch));

        return null;
    });

export const deleteThreadInvite = internalMutation
    .input({
        inviteId: v.id("threadInvites"),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.delete(args.inviteId);

        return null;
    });
