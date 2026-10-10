import type { Infer } from "lunorash/server";
import { signDocsForDisplay } from "../agent/display-media";
import { LunoraError } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { listActivePathPage } from "../agent/branches";
import { listMessagesByThreadIdHandler } from "../agent/messages";
import { getThreadInvitesWithAccessCheckHandler, grantOwnerForThread, listThreadAccessHandler } from "../agent/sharing";
import { checkThreadAccessBatchHandler } from "../agent/threads";
import { toUIMessages } from "../agent/ui-messages";
import type { MessageDoc } from "../agent/validators";
import { vThreadDocFields } from "../agent/validators";
import { callOnShard } from "../lib/cross-shard";
import { authAction, authMutation, authQuery, publicAction, rateLimit } from "../lib/crpc";
import { rateLimitGuard, shareLinkBucket } from "../lib/rate-limiter";
import { deleteShardRoute, setShardRoute, shardRouteOwner } from "../lib/shard-routes";
import { admitThread, systemDb } from "../lib/rls/scope";
import { loadNsfwStatuses, MAX_PUBLIC_THREAD_ROWS, toPublicThreadMessages, vPublicThreadMessage } from "./lib/public-thread";
import { MAX_LENGTH } from "../lib/validators";

// Helper function to generate unique tokens
const generateToken = (): string => crypto.randomUUID();
// Helper function to calculate expiration time
const calculateExpirationTime = (expirationType: "1_day" | "7_days" | "custom", customHours?: number): number => {
    const now = Date.now();

    switch (expirationType) {
        case "1_day": {
            return now + 24 * 60 * 60 * 1000;
        }
        case "7_days": {
            return now + 7 * 24 * 60 * 60 * 1000;
        }
        case "custom": {
            if (!customHours || customHours <= 0) {
                throw new LunoraError("BAD_REQUEST", "Custom hours must be greater than 0");
            }

            return now + customHours * 60 * 60 * 1000;
        }
        default: {
            throw new LunoraError("BAD_REQUEST", "Invalid expiration type");
        }
    }
};

// Check if user has access to a thread
// Calls handler directly to bypass runQuery validator overhead
export const checkThreadAccess = internalQuery
    .input({
        requiredPermission: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.boolean())
    .query(async ({ args: { requiredPermission = "read", threadId, userId }, ctx: context }) => {
        const result = await checkThreadAccessBatchHandler(context, {
            requiredPermission,
            threadId: threadId as Id<"threads">,
            userId,
        });

        return result.hasAccess;
    });

// Combined access check that returns both access status AND thread data in one call
// Calls handler directly to bypass runQuery validator overhead
export const checkThreadAccessWithData = internalQuery
    .input({
        requiredPermission: v.optional(v.union(v.literal("read"), v.literal("write"), v.literal("admin"))),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.union(
            v.object({
                hasAccess: v.literal(true),
                permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
                // The whole row as `publicThread` returns it. A hand-listed subset
                // rejected every thread carrying a column it forgot (category,
                // activeLeafMessageId, groupChat, tagIds...), failing the share
                // toggle, thread updates and follow-ups on exactly those threads.
                thread: v.object({ ...vThreadDocFields }),
            }),
            v.object({
                hasAccess: v.literal(false),
                permission: v.null(),
                thread: v.null(),
            }),
        ),
    )
    .query(
        async ({ args: { requiredPermission = "read", threadId, userId }, ctx: context }) =>
            await checkThreadAccessBatchHandler(context, {
                requiredPermission,
                threadId: threadId as Id<"threads">,
                userId,
            }),
    );

// Get thread access information
const vGetThreadAccessOutput = v.object({
    isOwner: v.boolean(),
    isPublic: v.boolean(),
    permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
    publicAccessToken: v.optional(v.string()),
    users: v.array(
        v.object({
            email: v.string(),
            expiresAt: v.optional(v.number()),
            grantedAt: v.number(),
            name: v.optional(v.string()),
            permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
            userId: v.string(),
        }),
    ),
});

export const getThreadAccess = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.from(vGetThreadAccessOutput))
    .query(async ({ args: { threadId }, ctx: context }): Promise<Infer<typeof vGetThreadAccessOutput>> => {
        const { userId } = context.user;

        // Direct handler calls — bypasses 3 levels of runQuery validator overhead.
        // In order, not in parallel: the access check is what admits the thread,
        // and row-level security shows the other grants only after it.
        const accessResult = await checkThreadAccessBatchHandler(context, {
            requiredPermission: "read",
            threadId: threadId as Id<"threads">,
            userId,
        });
        const accessList = await listThreadAccessHandler(context, {
            threadId: threadId as Id<"threads">,
        });

        if (!accessResult.hasAccess || !accessResult.thread) {
            throw new LunoraError("FORBIDDEN", "Access denied");
        }

        const { thread } = accessResult;
        const isOwner = thread.userId === userId;

        // Batch fetch user details for all access entries - using Promise.all is fine here
        // since we need ALL users. This is not an N+1 - it's a necessary batch fetch.
        const userIds = accessList.map((access) => access.userId);
        // Through the table facade: behind row-level security an un-hinted `db.get`
        // of a `.global()` row probes every policed table to learn which one it is.
        const usersData = await Promise.all(userIds.map(async (uid) => await context.db.user.findFirst({ where: { _id: uid as Id<"user"> } })));

        // Who else a thread is shared with is visible to every grantee (names,
        // permissions), but their EMAIL addresses only to those who manage sharing.
        const canManageSharing = accessResult.permission === "admin";

        const users = accessList.map((access, index) => {
            const user = usersData[index];

            return {
                email: canManageSharing ? user?.email || "" : "",
                expiresAt: access.expiresAt,
                grantedAt: access.grantedAt,
                name: typeof user?.name === "string" ? user.name : undefined,
                permission: access.permission,
                userId: access.userId,
            };
        });

        return {
            isOwner,
            isPublic: thread.isPublic || false,
            permission: isOwner ? "admin" : accessList.find((a) => a.userId === userId)?.permission || "read",
            publicAccessToken: thread.publicAccessToken,
            users,
        };
    });

/**
 * The shard a thread shared WITH the caller lives on — its owner's — or `null`
 * for a thread the caller owns, or cannot reach. The client routes every call
 * about the thread there (`apps/web/src/lib/lunora/shard-routing.ts`,
 * docs/plans/per-user-sharding.md). Reads only the caller's own `.global()`
 * grant, so it answers from their own shard and reveals nothing about threads
 * they were not granted.
 */
export const resolveThreadShard = authQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { threadId }, ctx: context }) => await grantOwnerForThread(context, threadId, context.user.userId));

// Create an invite for a thread
export const createThreadInvite = authMutation
    .use(rateLimit("sharing/create"))
    .input({
        customHours: v.optional(v.number()),
        expirationType: v.union(v.literal("1_day"), v.literal("7_days"), v.literal("custom")),
        invitedEmail: v.string().max(MAX_LENGTH.short),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        threadId: v.id("threads"),
    })
    .output(v.object({ expiresAt: v.number(), inviteToken: v.string() }))
    .mutation(async ({ args: { customHours, expirationType, invitedEmail, permission, threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Validate threadId is not empty
        if (!threadId || threadId.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "Thread ID is required");
        }

        // Check if user has admin access to this thread
        const accessResult = await context.runQuery(internal.chat.sharing.checkThreadAccessWithData, {
            requiredPermission: "admin",
            threadId,
            userId,
        });

        if (!accessResult.hasAccess || !accessResult.thread.userId) {
            throw new LunoraError("FORBIDDEN", "Admin access required to create invites");
        }

        // Check if invite already exists for this email and thread
        const invites = await context.runQuery(internal.agent.sharing.listThreadInvites, {
            threadId,
        });

        const existingInvite = invites.find((invite) => invite.invitedEmail === invitedEmail && invite.status === "pending");

        if (existingInvite) {
            throw new LunoraError("BAD_REQUEST", "An invite already exists for this email");
        }

        const inviteToken = generateToken();
        const expiresAt = calculateExpirationTime(expirationType, customHours);

        await context.runMutation(internal.agent.sharing.createThreadInvite, {
            expiresAt,
            invitedBy: userId,
            invitedEmail,
            inviteToken,
            // The thread's shard: the invitee redeems from their own, and the
            // grant it writes is what later admits them to this one.
            ownerId: accessResult.thread.userId,
            permission,
            threadId,
        });

        context.log.event("chat.create_thread_invite", { expirationType, permission });

        return {
            expiresAt,
            inviteToken,
        };
    });

// Get pending invites for a thread
const vGetThreadInvitesOutput = v.array(
    v.object({
        _id: v.string(),
        expiresAt: v.number(),
        invitedAt: v.number(),
        invitedEmail: v.string(),
        inviteToken: v.string(),
        permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")),
        status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("expired"), v.literal("revoked")),
    }),
);

export const getThreadInvites = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .output(v.from(vGetThreadInvitesOutput))
    .query(async ({ args: { threadId }, ctx: context }): Promise<Infer<typeof vGetThreadInvitesOutput>> => {
        const { userId } = context.user;

        if (!threadId || threadId.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "Thread ID is required");
        }

        // Direct handler call — bypasses runQuery validator overhead on complex invite type
        const invites = await getThreadInvitesWithAccessCheckHandler(context, {
            threadId: threadId as Id<"threads">,
            userId,
        });

        if (!invites) {
            throw new LunoraError("FORBIDDEN", "Access denied to this thread");
        }

        return invites.map((invite) => {
            return {
                _id: invite._id,
                expiresAt: invite.expiresAt,
                invitedAt: invite._creationTime,
                invitedEmail: invite.invitedEmail,
                inviteToken: invite.inviteToken,
                permission: invite.permission,
                status: invite.status,
            };
        });
    });

// Revoke an invite
export const revokeThreadInvite = authMutation
    .use(rateLimit("sharing/update"))
    .input({
        inviteId: v.id("threadInvites"),
    })
    .mutation(async ({ args: { inviteId }, ctx: context }) => {
        const { userId } = context.user;

        // Get invite using component function
        const invite = await context.runQuery(internal.agent.sharing.getThreadInviteById, {
            inviteId,
        });

        if (!invite) {
            throw new LunoraError("NOT_FOUND", "Invite not found");
        }

        // Check if user has admin access to this thread
        const hasAccess = await context.runQuery(internal.chat.sharing.checkThreadAccess, {
            requiredPermission: "admin",
            threadId: invite.threadId as string,
            userId,
        });

        if (!hasAccess) {
            throw new LunoraError("FORBIDDEN", "Admin access required to revoke invites");
        }

        await context.runMutation(internal.agent.sharing.updateThreadInvite, {
            inviteId,
            status: "revoked",
        });
        context.log.event("chat.revoke_thread_invite", { revoked: true });
    });

export const acceptThreadInvite = authMutation
    .use(rateLimit("sharing/update"))
    .input({
        inviteToken: v.string().max(MAX_LENGTH.short),
    })
    // `ownerId` is the shard the thread lives on — the client routes every call
    // about this thread there (docs/plans/per-user-sharding.md).
    .output(v.object({ ownerId: v.string(), permission: v.union(v.literal("read"), v.literal("write"), v.literal("admin")), threadId: v.string() }))
    .mutation(async ({ args: { inviteToken }, ctx: context }) => {
        const { userId } = context.user;

        const invite = await context.runQuery(internal.agent.sharing.getThreadInvite, {
            inviteToken,
        });

        if (!invite) {
            throw new LunoraError("NOT_FOUND", "Invalid invite token");
        }

        if (invite.status !== "pending") {
            throw new LunoraError("BAD_REQUEST", "Invite is no longer valid");
        }

        const { ownerId } = invite;

        if (!ownerId) {
            throw new LunoraError("BAD_REQUEST", "Invite is no longer valid");
        }

        if (invite.expiresAt < context.now) {
            await context.runMutation(internal.agent.sharing.updateThreadInvite, {
                inviteId: invite._id,
                status: "expired",
            });
            throw new LunoraError("BAD_REQUEST", "Invite has expired");
        }

        // Check if user already has access
        const existingAccess = await context.runQuery(internal.agent.sharing.getThreadAccess, {
            threadId: invite.threadId,
            userId,
        });

        if (existingAccess) {
            // Update existing access with new permission
            await context.runMutation(internal.agent.sharing.updateThreadAccess, {
                accessId: existingAccess._id,
                permission: invite.permission,
            });
        } else {
            // Create new access
            await context.runMutation(internal.agent.sharing.createThreadAccess, {
                grantedBy: invite.invitedBy,
                ownerId,
                permission: invite.permission,
                threadId: invite.threadId,
                userId,
            });
        }

        // Mark invite as accepted
        await context.runMutation(internal.agent.sharing.updateThreadInvite, {
            acceptedAt: context.now,
            acceptedBy: userId,
            inviteId: invite._id,
            status: "accepted",
        });

        context.log.event("chat.accept_thread_invite", { alreadyHadAccess: Boolean(existingAccess), permission: invite.permission });

        return {
            ownerId,
            permission: invite.permission,
            threadId: invite.threadId,
        };
    });

// Remove user access from thread
export const removeThreadAccess = authMutation
    .use(rateLimit("sharing/update"))
    .input({
        targetUserId: v.string().max(MAX_LENGTH.id),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: { targetUserId, threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Check if user has admin access and get thread data in one call
        // Using checkThreadAccessWithData eliminates a duplicate thread fetch
        const accessResult = await context.runQuery(internal.chat.sharing.checkThreadAccessWithData, {
            requiredPermission: "admin",
            threadId,
            userId,
        });

        if (!accessResult.hasAccess || !accessResult.thread) {
            throw new LunoraError("FORBIDDEN", "Admin access required to remove users");
        }

        // Don't allow removing the thread owner
        if (accessResult.thread.userId === targetUserId) {
            throw new LunoraError("BAD_REQUEST", "Cannot remove thread owner");
        }

        const access = await context.runQuery(internal.agent.sharing.getThreadAccess, {
            threadId,
            userId: targetUserId,
        });

        if (access) {
            await context.runMutation(internal.agent.sharing.deleteThreadAccess, {
                accessId: access._id,
            });
        }

        context.log.event("chat.remove_thread_access", { removed: Boolean(access) });
    });

// Toggle thread public visibility
export const toggleThreadVisibility = authMutation
    .use(rateLimit("sharing/update"))
    .input({
        isPublic: v.boolean(),
        threadId: v.id("threads"),
    })
    .output(v.object({ isPublic: v.boolean(), publicAccessToken: v.optional(v.string()) }))
    .mutation(async ({ args: { isPublic, threadId }, ctx: context }) => {
        const { userId } = context.user;

        // Check if user has admin access and get thread data in one call
        // Using checkThreadAccessWithData eliminates a duplicate thread fetch
        const accessResult = await context.runQuery(internal.chat.sharing.checkThreadAccessWithData, {
            requiredPermission: "admin",
            threadId,
            userId,
        });

        if (!accessResult.hasAccess || !accessResult.thread) {
            throw new LunoraError("FORBIDDEN", "Admin access required to change thread visibility");
        }

        const newToken = isPublic ? generateToken() : undefined;
        const previousToken = accessResult.thread.publicAccessToken;

        // Update thread visibility using component function
        await context.runMutation(internal.agent.threads.updateThreadVisibility, {
            isPublic,
            publicAccessToken: newToken,
            threadId: threadId as Id<"threads">,
        });

        // The anonymous share page resolves its token to this thread's shard
        // through `shardRoutes`; a rotated or withdrawn token stops routing.
        if (previousToken) {
            await deleteShardRoute(context, "thread-public", previousToken);
        }

        if (newToken && accessResult.thread.userId) {
            await setShardRoute(context, "thread-public", newToken, accessResult.thread.userId);
            await setShardRoute(context, "thread-share", threadId, accessResult.thread.userId);
        } else {
            await deleteShardRoute(context, "thread-share", threadId);
        }

        context.log.event("chat.toggle_thread_visibility", { isPublic, tokenIssued: newToken !== undefined });

        return {
            isPublic,
            publicAccessToken: newToken,
        };
    });

/** Share tokens are `crypto.randomUUID()` — anything far longer is not one. */
const MAX_PUBLIC_ACCESS_TOKEN_LENGTH = 128;

const vPublicThread = v.object({
    createdAt: v.number(),
    messages: v.array(vPublicThreadMessage),
    title: v.optional(v.string()),
    /** More rows exist than `MAX_PUBLIC_THREAD_ROWS`; only the latest are shown. */
    truncated: v.boolean(),
});

/**
 * The anonymous share page's only read (`/thread/$token`).
 *
 * Not-found, made-private, revoked (the token is rotated on every re-publish),
 * deleted and temporary all answer `null` alike, so a token probe learns nothing
 * beyond "not a live share". The output is an allow-list projection
 * (`chat/lib/public-thread.ts`): no thread id, user id, system prompt, tool
 * input/output, reasoning or user-uploaded file URL leaves here.
 */
export const getPublicThread = publicAction
    .input({
        publicAccessToken: v.string().max(MAX_LENGTH.short),
    })
    .use(rateLimit("share/view"))
    .output(v.from(v.union(vPublicThread, v.null())))
    .action(async ({ args: { publicAccessToken }, ctx: context }): Promise<Infer<typeof vPublicThread> | null> => {
        if (publicAccessToken.length === 0 || publicAccessToken.length > MAX_PUBLIC_ACCESS_TOKEN_LENGTH) {
            return null;
        }

        // The thread lives on its owner's shard, which an anonymous caller is
        // never admitted to. So the token is resolved to that shard here
        // (`shardRoutes`, `.global()`), and the read runs there as the system —
        // the internal query re-checks the token itself.
        const ownerId = await context.runQuery(internal.chat.sharing.getPublicThreadOwner, { publicAccessToken });

        if (!ownerId) {
            return null;
        }

        // Per-link bucket, now that the token is known to be a live link: a rate-limit row
        // is written only for a real share (see `shareLinkBucket`).
        await rateLimitGuard({
            ...context,
            identifier: await shareLinkBucket(publicAccessToken),
            rateLimitKey: "share/view",
            user: null,
        } as never);

        const thread = await callOnShard(internal.chat.sharing.readPublicThread, { publicAccessToken }, { shardKey: ownerId });

        context.log.event("chat.get_public_thread", { found: thread !== null });

        return thread;
    });

/**
 * The share token of a PUBLIC thread someone else owns, for `/chat/<id>` opened
 * by a signed-in viewer with no grant on it: they belong on `/thread/<token>`.
 *
 * Before per-user sharding the redacted `getThread` carried the token; now that
 * read lands on the viewer's OWN shard, where the thread is not. So the id is
 * resolved to its owner through `shardRoutes` (`thread-share`, kept by
 * `toggleThreadVisibility`) and the token read on that shard as the system —
 * the internal query answers only for a live public thread. Anything else is
 * `null`, which the page treats as not found.
 */
export const getThreadShareToken = authAction
    .use(rateLimit("sharing/create"))
    .input({ threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .action(async ({ args: { threadId }, ctx: context }): Promise<string | null> => {
        const ownerId = await context.runQuery(internal.lib.shard_routes.getRouteOwner, { kind: "thread-share", value: threadId });

        if (!ownerId || ownerId === context.user.userId) {
            return null;
        }

        const token = await callOnShard(internal.chat.sharing.readThreadShareToken, { threadId }, { shardKey: ownerId });

        context.log.event("chat.get_thread_share_token", { found: token !== null });

        return token;
    });

/** `getThreadShareToken`'s read, on the thread owner's shard. */
export const readThreadShareToken = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { threadId }, ctx: context }): Promise<string | null> => {
        const thread = await systemDb(context).get(threadId);

        if (!thread || thread.isPublic !== true || thread.deleted === true || thread.isTemporary === true) {
            return null;
        }

        return typeof thread.publicAccessToken === "string" && thread.publicAccessToken.length > 0 ? thread.publicAccessToken : null;
    });

export const getPublicThreadOwner = internalQuery
    .input({ publicAccessToken: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { publicAccessToken }, ctx }) => await shardRouteOwner(ctx, "thread-public", publicAccessToken));

/** `getPublicThread`'s read, on the thread owner's shard. */
export const readPublicThread = internalQuery
    .input({
        publicAccessToken: v.string(),
    })
    .output(v.from(v.union(vPublicThread, v.null())))
    .query(async ({ args: { publicAccessToken }, ctx: context }): Promise<Infer<typeof vPublicThread> | null> => {
        if (publicAccessToken.length === 0 || publicAccessToken.length > MAX_PUBLIC_ACCESS_TOKEN_LENGTH) {
            return null;
        }

        // The token is the capability: looked up past row-level security, then
        // admitted as the `public` view so the message reads below go through.
        const thread = await systemDb(context)
            .query("threads")
            .withIndex("by_publicAccessToken", (q) => q.eq("publicAccessToken", publicAccessToken))
            .first();

        if (!thread || thread.isPublic !== true || thread.deleted === true || thread.isTemporary === true) {
            return null;
        }

        admitThread(context, thread._id, "public");

        // Latest rows first, so a thread past the cap shows its most recent turns.
        // `toUIMessages` re-sorts ascending and groups tool rows into their turn.
        // A branched thread shows only its ACTIVE path, as in the app: sibling
        // replies share an `order`, and `toUIMessages` would merge them.
        const pathPage = await listActivePathPage(context, thread, { cursor: null, numItems: MAX_PUBLIC_THREAD_ROWS });
        const rows = pathPage
            ? { ...pathPage, page: pathPage.page.filter((row) => row.status === "success") }
            : await listMessagesByThreadIdHandler(context, {
                  order: "desc",
                  paginationOpts: { cursor: null, numItems: MAX_PUBLIC_THREAD_ROWS },
                  statuses: ["success"],
                  threadId: thread._id,
              });
        // Same re-brand as `getThreadUIMessages`: raw rows whose JSON columns the
        // generated model types as `unknown`, identical at runtime to `MessageDoc`.
        const uiMessages = toUIMessages(await signDocsForDisplay(context, rows.page as unknown as MessageDoc[]));

        const nsfwStatusByFileId = await loadNsfwStatuses(context, uiMessages);

        return {
            createdAt: thread._creationTime,
            messages: toPublicThreadMessages(uiMessages, nsfwStatusByFileId),
            title: typeof thread.title === "string" && thread.title.length > 0 ? thread.title : undefined,
            truncated: !rows.isDone,
        };
    });
