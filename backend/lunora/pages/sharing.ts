/**
 * Sharing a page: grants to other users, link invites that create a grant, and
 * a public read-only link.
 *
 * - Grants (`pageAccess`) follow the thread-sharing model: the owner is admin,
 *   a grantee gets exactly the permission granted. Managing grants needs admin;
 *   anyone may remove their OWN grant (leave a page).
 * - An invite is a link. Its token is returned once and stored as a SHA-256, so
 *   a lost link is reissued, never recovered; accepting turns it into a grant
 *   and spends it.
 * - The public link (`getPublicPage`) is keyed by a random token, rotated on
 *   every re-publish, and answers an allow-list projection with comment marks
 *   stripped: no ids, no owner, no comments. Not-found, unpublished and revoked
 *   all answer `null` alike.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { callOnShard } from "../lib/cross-shard";
import { authAction, authMutation, authQuery, publicAction, rateLimit } from "../lib/crpc";
import { rateLimitGuard, shareLinkBucket } from "../lib/rate-limiter";
import { deleteShardRoute, setShardRoute, shardRouteOwner } from "../lib/shard-routes";
import { patchRow } from "../lib/patch";
import { sha256Hex } from "../lib/crypto";
import { admitPage, admitPageInvite, parentKeyOf, systemDb } from "../lib/rls/scope";
import { requirePageAccess, resolvePageAccess } from "./access";
import { stripCommentMarks } from "./comment-anchors";
import { vPagePermission } from "./functions";
import { MAX_LENGTH } from "../lib/validators";

const MAX_GRANTS_PER_PAGE = 50;
const MAX_PENDING_INVITES_PER_PAGE = 20;
const MAX_INVITE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Share tokens are `crypto.randomUUID()` — anything far longer is not one. */
const MAX_TOKEN_LENGTH = 128;

/** A page's grants — `pageAccess` is `.global()`, so every grantee's, from any shard. */
const loadGrants = async (ctx: Pick<QueryCtx, "db">, pageId: Id<"pages">, limit: number): Promise<Doc<"pageAccess">[]> => {
    const { page } = await ctx.db.pageAccess.findMany({ limit, orderBy: [{ userId: "asc" }], where: { pageId } });

    return page;
};

/** A page's invites (`.global()`), newest last. */
const loadInvites = async (ctx: Pick<QueryCtx, "db">, pageId: Id<"pages">): Promise<Doc<"pageInvites">[]> => {
    const { page } = await ctx.db.pageInvites.findMany({ limit: 200, orderBy: [{ _creationTime: "asc" }], where: { pageId } });

    return page;
};

const vPageSharing = v.object({
    grants: v.array(
        v.object({
            email: v.union(v.string(), v.null()),
            grantedAt: v.number(),
            name: v.union(v.string(), v.null()),
            permission: vPagePermission,
            userId: v.string(),
        }),
    ),
    invites: v.array(
        v.object({
            _id: v.id("pageInvites"),
            createdAt: v.number(),
            expiresAt: v.number(),
            permission: vPagePermission,
        }),
    ),
    isPublic: v.boolean(),
    publicAccessToken: v.union(v.string(), v.null()),
});

const vPublicPage = v.object({
    contentJson: v.optional(v.any()),
    icon: v.union(v.string(), v.null()),
    title: v.string(),
    updatedAt: v.number(),
});

export const getPageSharing = authQuery
    .input({ pageId: v.id("pages") })
    .output(v.from(vPageSharing))
    .query(async ({ args: { pageId }, ctx }): Promise<Infer<typeof vPageSharing>> => {
        const { page } = await requirePageAccess(ctx, pageId, ctx.user.userId, "admin");
        const [grants, invites] = await Promise.all([loadGrants(ctx, pageId, MAX_GRANTS_PER_PAGE), loadInvites(ctx, pageId)]);
        const users = await Promise.all(grants.map(async (grant) => await ctx.db.user.findFirst({ where: { _id: grant.userId as Id<"user"> } })));

        return {
            grants: grants.map((grant, index) => {
                const user = users[index];

                return {
                    email: typeof user?.email === "string" ? user.email : null,
                    grantedAt: grant.grantedAt,
                    name: typeof user?.name === "string" ? user.name : null,
                    permission: grant.permission,
                    userId: grant.userId,
                };
            }),
            // Expired ones included: the client greys them out, and a query stays deterministic.
            invites: invites
                .filter((invite) => invite.status === "pending")
                .map((invite) => {
                    return { _id: invite._id, createdAt: invite.createdAt, expiresAt: invite.expiresAt, permission: invite.permission };
                }),
            isPublic: page.isPublic === true,
            publicAccessToken: page.isPublic === true ? (page.publicAccessToken ?? null) : null,
        };
    });

/**
 * The shard a page shared WITH the caller lives on — its owner's — or `null`
 * for a page the caller owns, or cannot reach. See
 * `chat_sharing.resolveThreadShard`; reads only the caller's own grant.
 */
export const resolvePageShard = authQuery
    .input({ pageId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { pageId }, ctx }) => {
        const grant = await ctx.db.pageAccess.findFirst({ where: { pageId: pageId as Id<"pages">, userId: ctx.user.userId } });

        return grant?.ownerId ?? null;
    });

export const setPagePublic = authMutation
    .use(rateLimit("pages/share"))
    .input({ isPublic: v.boolean(), pageId: v.id("pages") })
    .output(v.object({ publicAccessToken: v.union(v.string(), v.null()) }))
    .mutation(async ({ args, ctx }) => {
        const { page } = await requirePageAccess(ctx, args.pageId, ctx.user.userId, "admin");
        // A fresh token on every publish: unpublishing then re-publishing revokes the old link.
        const publicAccessToken = args.isPublic ? crypto.randomUUID() : undefined;

        await patchRow(ctx.db, page, { isPublic: args.isPublic ? true : undefined, publicAccessToken });

        // The anonymous `/p/$token` page resolves its token to this page's shard
        // through `shardRoutes`; a rotated or withdrawn token stops routing.
        if (page.publicAccessToken) {
            await deleteShardRoute(ctx, "page-public", page.publicAccessToken);
        }

        if (publicAccessToken) {
            await setShardRoute(ctx, "page-public", publicAccessToken, page.userId);
        }

        ctx.log.event("pages.set_page_public", { isPublic: args.isPublic });

        return { publicAccessToken: publicAccessToken ?? null };
    });

export const createPageInvite = authMutation
    .use(rateLimit("pages/share"))
    .input({ expiresInDays: v.number(), pageId: v.id("pages"), permission: vPagePermission })
    .output(v.object({ expiresAt: v.number(), token: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        const { page } = await requirePageAccess(ctx, args.pageId, userId, "admin");

        if (!Number.isFinite(args.expiresInDays) || args.expiresInDays < 1 || args.expiresInDays > MAX_INVITE_DAYS) {
            throw new LunoraError("BAD_REQUEST", `An invite lasts between 1 and ${String(MAX_INVITE_DAYS)} days`);
        }

        const now = ctx.now;
        const invites = await loadInvites(ctx, args.pageId);
        const pending = invites.filter((invite) => invite.status === "pending" && invite.expiresAt > now);

        if (pending.length >= MAX_PENDING_INVITES_PER_PAGE) {
            throw new LunoraError("BAD_REQUEST", "Too many open invites; revoke some first");
        }

        const token = crypto.randomUUID();
        const expiresAt = now + Math.floor(args.expiresInDays) * DAY_MS;

        await ctx.db.insert("pageInvites", {
            createdAt: now,
            expiresAt,
            // The page's shard: the invitee redeems from their own.
            ownerId: page.userId,
            pageId: args.pageId,
            permission: args.permission,
            status: "pending",
            tokenHash: await sha256Hex(token),
            userId,
        });

        ctx.log.event("pages.create_page_invite", { hasExpiry: expiresAt !== undefined });

        return { expiresAt, token };
    });

export const revokePageInvite = authMutation
    .use(rateLimit("pages/share"))
    .input({ inviteId: v.id("pageInvites") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const pageId = await parentKeyOf(ctx, args.inviteId, "pageId");

        if (!pageId) {
            throw new LunoraError("NOT_FOUND", "Invite not found");
        }

        await requirePageAccess(ctx, pageId as Id<"pages">, ctx.user.userId, "admin");
        await ctx.db.patch(args.inviteId, { status: "revoked" });

        ctx.log.event("pages.revoke_page_invite", { revoked: true });

        return null;
    });

/**
 * Accept a page invite.
 *
 * The invitee runs this on their OWN shard, while the page — and the check that
 * its inviter may still share it — lives on the owner's
 * (docs/plans/per-user-sharding.md). So the token is resolved here (invites are
 * `.global()`) and the redeem runs on the owner's shard as the system,
 * re-checking everything from the token.
 */
export const acceptPageInvite = authAction
    .use(rateLimit("pages/share"))
    .input({ token: v.string().max(MAX_LENGTH.short) })
    .output(v.object({ ownerId: v.string(), pageId: v.id("pages") }))
    .action(async ({ args, ctx }) => {
        if (args.token.length === 0 || args.token.length > MAX_TOKEN_LENGTH) {
            throw new LunoraError("NOT_FOUND", "This invite is not valid");
        }

        const ownerId = await ctx.runQuery(internal.pages.sharing.getPageInviteOwner, { tokenHash: await sha256Hex(args.token) });

        if (!ownerId) {
            throw new LunoraError("NOT_FOUND", "This invite is not valid");
        }

        const { pageId } = await callOnShard(internal.pages.sharing.redeemPageInvite, { token: args.token, userId: ctx.user.userId }, { shardKey: ownerId });

        ctx.log.event("pages.accept_page_invite", { ownerId, pageId });

        return { ownerId, pageId };
    });

export const getPageInviteOwner = internalQuery
    .input({ tokenHash: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => {
        const invite = await ctx.db.pageInvites.findFirst({ where: { tokenHash: args.tokenHash } });

        return invite?.ownerId ?? null;
    });

/** `acceptPageInvite`'s redeem, on the page owner's shard, for `userId`. */
export const redeemPageInvite = internalMutation
    .input({ token: v.string(), userId: v.string() })
    .output(v.object({ pageId: v.id("pages") }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = args;

        if (args.token.length === 0 || args.token.length > MAX_TOKEN_LENGTH) {
            throw new LunoraError("NOT_FOUND", "This invite is not valid");
        }

        const tokenHash = await sha256Hex(args.token);
        // The bearer of the token is not a member of the page yet, so the invite
        // is looked up past row-level security and admitted once it checks out.
        const invite = await ctx.db.pageInvites.findFirst({ where: { tokenHash } });

        // Not found, revoked, spent and expired all read the same.
        if (!invite || invite.status !== "pending" || invite.expiresAt < ctx.now) {
            throw new LunoraError("NOT_FOUND", "This invite is not valid");
        }

        // The inviter must STILL be able to share the page: an admin grantee's
        // invites die with their grant, instead of outliving it.
        const inviterAccess = await resolvePageAccess(ctx, invite.pageId, invite.userId);

        if (!inviterAccess || inviterAccess.permission !== "admin") {
            throw new LunoraError("NOT_FOUND", "This invite is not valid");
        }

        const { page } = inviterAccess;

        admitPageInvite(ctx, invite._id);
        await ctx.db.patch(invite._id, { acceptedAt: ctx.now, acceptedBy: userId, status: "accepted" });

        // The owner opening their own link spends it and changes nothing.
        if (page.userId === userId) {
            return { pageId: page._id };
        }

        const existing = await ctx.db.pageAccess.findFirst({ where: { pageId: page._id, userId } });

        if (existing) {
            await ctx.db.patch(existing._id, { permission: invite.permission });
        } else {
            // Every grant on the page counts toward the cap, not only the ones
            // this (not yet member) caller could read.
            const grants = await loadGrants(ctx, page._id, MAX_GRANTS_PER_PAGE);

            if (grants.length >= MAX_GRANTS_PER_PAGE) {
                throw new LunoraError("BAD_REQUEST", "This page is shared with too many people");
            }

            await ctx.db.insert("pageAccess", {
                grantedAt: ctx.now,
                grantedBy: invite.userId,
                icon: page.icon,
                ownerId: page.userId,
                pageId: page._id,
                permission: invite.permission,
                title: page.title,
                userId,
            });
        }

        return { pageId: page._id };
    });

export const updatePageGrant = authMutation
    .use(rateLimit("pages/share"))
    .input({ pageId: v.id("pages"), permission: vPagePermission, targetUserId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await requirePageAccess(ctx, args.pageId, ctx.user.userId, "admin");

        const grant = await ctx.db.pageAccess.findFirst({ where: { pageId: args.pageId, userId: args.targetUserId } });

        if (!grant) {
            throw new LunoraError("NOT_FOUND", "That person has no access to this page");
        }

        await ctx.db.patch(grant._id, { permission: args.permission });

        ctx.log.event("pages.update_page_grant", { permission: args.permission });

        return null;
    });

/** Admins remove anyone's grant; any grantee may remove their own (leave the page). */
export const removePageGrant = authMutation
    .use(rateLimit("pages/share"))
    .input({ pageId: v.id("pages"), targetUserId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        if (args.targetUserId !== userId) {
            await requirePageAccess(ctx, args.pageId, userId, "admin");
        }

        const grant = await ctx.db.pageAccess.findFirst({ where: { pageId: args.pageId, userId: args.targetUserId } });

        if (grant) {
            await ctx.db.delete(grant._id);
        }

        // A star on a page they can no longer open is dead weight in their sidebar.
        const favorite = await ctx.db
            .query("pageFavorites")
            .withIndex("by_user_and_page", (q) => q.eq("userId", args.targetUserId).eq("pageId", args.pageId))
            .first();

        if (favorite) {
            await ctx.db.delete(favorite._id);
        }

        ctx.log.event("pages.remove_page_grant", { removedGrant: grant !== null, removedFavorite: favorite !== null });

        return null;
    });

/** The anonymous share page's only read (`/p/$token`). See the module comment. */
export const getPublicPage = publicAction
    .input({ publicAccessToken: v.string().max(MAX_LENGTH.short) })
    .use(rateLimit("share/view"))
    .output(v.from(v.union(vPublicPage, v.null())))
    .action(async ({ args: { publicAccessToken }, ctx }): Promise<Infer<typeof vPublicPage> | null> => {
        if (publicAccessToken.length === 0 || publicAccessToken.length > MAX_TOKEN_LENGTH) {
            return null;
        }

        // The page lives on its owner's shard, which an anonymous caller is never
        // admitted to: resolve the token to that shard (`shardRoutes`) and read
        // there as the system — `readPublicPage` re-checks the token itself.
        const ownerId = await ctx.runQuery(internal.pages.sharing.getPublicPageOwner, { publicAccessToken });

        if (!ownerId) {
            return null;
        }

        // Per-link bucket, now that the token is known to be a live link: a rate-limit row
        // is written only for a real share (see `shareLinkBucket`).
        await rateLimitGuard({
            ...ctx,
            identifier: await shareLinkBucket(publicAccessToken),
            rateLimitKey: "share/view",
            user: null,
        } as never);

        const page = await callOnShard(internal.pages.sharing.readPublicPage, { publicAccessToken }, { shardKey: ownerId });

        ctx.log.event("pages.get_public_page", { found: page !== null });

        return page;
    });

export const getPublicPageOwner = internalQuery
    .input({ publicAccessToken: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { publicAccessToken }, ctx }) => await shardRouteOwner(ctx, "page-public", publicAccessToken));

/** `getPublicPage`'s read, on the page owner's shard. */
export const readPublicPage = internalQuery
    .input({ publicAccessToken: v.string() })
    .output(v.from(v.union(vPublicPage, v.null())))
    .query(async ({ args: { publicAccessToken }, ctx }): Promise<Infer<typeof vPublicPage> | null> => {
        if (publicAccessToken.length === 0 || publicAccessToken.length > MAX_TOKEN_LENGTH) {
            return null;
        }

        // The token is the capability: looked up past row-level security, and
        // admitted as the redacted `public` view once it checks out.
        const page = await systemDb(ctx)
            .query("pages")
            .withIndex("by_publicAccessToken", (q) => q.eq("publicAccessToken", publicAccessToken))
            .first();

        if (!page || page.isPublic !== true) {
            return null;
        }

        admitPage(ctx, page._id, "public");

        return {
            contentJson: page.contentJson === undefined ? undefined : stripCommentMarks(page.contentJson),
            icon: page.icon ?? null,
            title: page.title,
            updatedAt: page.updatedAt,
        };
    });
