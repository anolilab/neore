/**
 * The conversation to reopen for a user who resumes their latest chat: the most
 * recently ACTIVE live thread that is not archived, temporary or a branch.
 *
 * Read by activity (`updatedAt`), not the thread list's creation-time page,
 * and branch status is checked per candidate, so a long history cannot hide
 * the thread the user was last in. `by_user_and_organization_and_updatedAt`
 * reads only the active workspace's threads, so other workspaces never count
 * against the walk. The team is not an index column (it is optional in the
 * sidebar scope), so it is checked per candidate under `scanPages`' page budget.
 */
import { v } from "lunorash/server";

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

        await scanPages(
            async (cursor) =>
                await ctx.db.threads.findMany({
                    cursor,
                    limit: PAGE_SIZE,
                    orderBy: [{ updatedAt: "desc" }],
                    // `null` is the personal space, an unset column.
                    where: { organizationId: args.organizationId === null ? { isNull: true } : args.organizationId, userId },
                }),
            async (thread) => {
                // `deleted` is unset on ordinary inserts, and unset means live (as in the thread list).
                // Archived is the only status that is not live: a thread streaming a reply or one whose last run
                // failed is still the user's latest chat.
                if (thread.deleted || thread.status === "archived" || thread.isTemporary) {
                    return false;
                }

                if (args.teamId !== undefined && thread.teamId !== args.teamId) {
                    return false;
                }

                if (await ctx.db.threadRelationships.findFirst({ where: { threadId: thread._id } })) {
                    return false;
                }

                found = thread._id as string;

                return true;
            },
        );

        return found;
    });
