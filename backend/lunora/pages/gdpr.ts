/**
 * Pages in the GDPR export and account deletion.
 *
 * Wired into `gdpr/workflows/export-workflow.ts` ("collect-pages") and
 * `gdpr/workflows/deletion-workflow.ts` ("delete-user-pages"), following the
 * residual steps' contract (`gdpr/steps/residual-deletion-steps.ts`): at most
 * `BATCH` rows per table per call, `{ hasMore }` back, idempotent on retry.
 *
 * What is the user's:
 * - pages they own, with everything hanging off them (other people's comments
 *   and grants on those pages go too — the page they point at is gone);
 * - comments they wrote, grants they hold, their favorites and presence rows,
 *   on anyone's page;
 * - version snapshots they authored on SOMEONE ELSE'S page hold that owner's
 *   content, so they stay — with the author id replaced by the deleted marker.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { DELETED_USER_MARKER } from "../gdpr/steps/residual-deletion-steps";
import { deletePageRows } from "./functions";
import { MAX_PAGES_PER_USER } from "./logic";

const BATCH = 100;

/** Pages fully deleted per call: each drags its comments, versions and grants along. */
const PAGES_PER_CALL = 10;

const EXPORT_VERSIONS_PER_PAGE = 20;

export const collectPagesForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ comments: v.array(v.any()), favorites: v.array(v.any()), grants: v.array(v.any()), pages: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const [pages, comments, grants, favorites] = await Promise.all([
            ctx.db
                .query("pages")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(MAX_PAGES_PER_USER),
            ctx.db
                .query("pageComments")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(10_000),
            ctx.db.pageAccess.findMany({ limit: MAX_PAGES_PER_USER, where: { userId } }).then((result) => result.page),
            ctx.db
                .query("pageFavorites")
                .withIndex("by_user_and_page", (q) => q.eq("userId", userId))
                .take(MAX_PAGES_PER_USER),
        ]);

        const withVersions = await Promise.all(
            pages.map(async ({ publicAccessToken: _token, searchText: _search, ...page }) => {
                const versions = await ctx.db
                    .query("pageVersions")
                    .withIndex("by_page_and_created", (q) => q.eq("pageId", page._id))
                    .order("desc")
                    .take(EXPORT_VERSIONS_PER_PAGE);

                return { ...page, versions };
            }),
        );

        return {
            comments,
            favorites: favorites.map((favorite) => {
                return { createdAt: favorite.createdAt, pageId: favorite.pageId };
            }),
            grants: grants.map((grant) => {
                return { grantedAt: grant.grantedAt, pageId: grant.pageId, permission: grant.permission };
            }),
            pages: withVersions,
        };
    });

export const deleteUserPages = internalMutation
    .input({ userId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { userId }, ctx }) => {
        const owned = await ctx.db
            .query("pages")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .take(PAGES_PER_CALL);

        // Children first is not needed here: every page of the user goes, and
        // `deletePageRows` removes only rows keyed by the page itself.
        for (const page of owned) {
            await deletePageRows(ctx, page._id as Id<"pages">);
        }

        const [comments, grants, presence, invites, authored, favorites] = await Promise.all([
            ctx.db
                .query("pageComments")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db.pageAccess.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
            ctx.db
                .query("pagePresence")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db.pageInvites.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
            ctx.db
                .query("pageVersions")
                .withIndex("by_user", (q) => q.eq("userId", userId))
                .take(BATCH),
            ctx.db
                .query("pageFavorites")
                .withIndex("by_user_and_page", (q) => q.eq("userId", userId))
                .take(BATCH),
        ]);

        // Replies by OTHER people under the user's root comment go with it, or
        // they would dangle under a missing root.
        for (const comment of comments) {
            if (comment.parentId === undefined) {
                const pageComments = await ctx.db
                    .query("pageComments")
                    .withIndex("by_page_and_created", (q) => q.eq("pageId", comment.pageId))
                    .collect();
                const replies = pageComments.filter((reply) => reply.parentId === comment._id);

                for (const reply of replies) {
                    await ctx.db.delete(reply._id);
                }
            }

            await ctx.db.delete(comment._id).catch(() => undefined);
        }

        for (const row of [...grants, ...presence, ...invites, ...favorites]) {
            await ctx.db.delete(row._id);
        }

        for (const version of authored) {
            await ctx.db.patch(version._id, { userId: DELETED_USER_MARKER });
        }

        return { hasMore: owned.length >= PAGES_PER_CALL || [comments, grants, presence, invites, authored, favorites].some((rows) => rows.length >= BATCH) };
    });
