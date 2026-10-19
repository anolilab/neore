/**
 * The conversation to reopen for a user who resumes their latest chat: the most
 * recently ACTIVE live thread that is not archived, temporary or a branch.
 *
 * Read by activity (`updatedAt`), not the thread list's creation-time page, so
 * a long history cannot hide the thread the user was last in. Archived,
 * temporary and deleted threads are filtered in the query; only branch status
 * is checked per candidate. `by_user_and_organization_and_updatedAt` reads only
 * the active workspace's threads. The team is not an index column, so a
 * team-scoped walk still runs under `scanPages`' page budget.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { liteAuthQuery } from "../lib/crpc";
import { scanPages } from "../lib/scan-pages";
import { MAX_LENGTH } from "../lib/validators";

/** Threads read per page. */
const PAGE_SIZE = 100;

export const latestResumableThread = liteAuthQuery
    .input({
        // Same scope as the sidebar: null is the personal space; teamId is set only when a team is active.
        organizationId: v.union(v.string().max(MAX_LENGTH.id), v.null()),
        teamId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }): Promise<string | null> => {
        const { userId } = ctx.user;
        let found: string | null = null;
        // The page's threads that are branches: one lookup per page, not one per thread.
        let branchIds = new Set<string>();

        await scanPages(
            async (cursor) => {
                const threads = await ctx.db.threads.findMany({
                    cursor,
                    limit: PAGE_SIZE,
                    orderBy: [{ updatedAt: "desc" }],
                    // Every filter sits in the query, so the page budget counts eligible rows, not the user's
                    // whole history. Unset means live: `deleted` and `isTemporary` are unset on ordinary inserts,
                    // and archived is the only status that is not live (a thread streaming a reply, or whose last
                    // run failed, is still the latest chat). `null` organization is the personal space, an unset column.
                    where: {
                        AND: [
                            { organizationId: args.organizationId === null ? { isNull: true } : args.organizationId },
                            { userId },
                            { OR: [{ deleted: { isNull: true } }, { deleted: false }] },
                            { OR: [{ status: { isNull: true } }, { status: { ne: "archived" } }] },
                            { OR: [{ isTemporary: { isNull: true } }, { isTemporary: false }] },
                            // A locked chat is not resumed: its proof is what opens it.
                            { lockedAt: { isNull: true } },
                            // Same team scope as the sidebar: without an active team, team threads are included.
                            ...(args.teamId === undefined ? [] : [{ teamId: args.teamId }]),
                        ],
                    },
                });

                // No limit: the lookup is bounded by the page's thread ids, and a thread may have several rows.
                const ids = threads.page.map((thread) => thread._id as Id<"threads">);
                const relationships = ids.length === 0 ? { page: [] } : await ctx.db.threadRelationships.findMany({ where: { threadId: { in: ids } } });

                branchIds = new Set(relationships.page.map((relationship) => relationship.threadId as string));

                return threads;
            },
            async (thread) => {
                // A branch is not a chat of its own: its parent is listed instead.
                if (branchIds.has(thread._id as string)) {
                    return false;
                }

                found = thread._id as string;

                return true;
            },
        );

        return found;
    });
