/**
 * The conversation to reopen for a user who resumes their latest chat: the most
 * recently ACTIVE live thread that is not archived, temporary or a branch.
 *
 * Read by activity (`updatedAt`), not the thread list's creation-time page,
 * and branch status is checked per candidate, so a long history cannot hide
 * the thread the user was last in.
 */
import { v } from "lunorash/server";

import { liteAuthQuery } from "../lib/crpc";

/** How many recent threads to test; each costs one branch lookup. */
const RESUME_SCAN_LIMIT = 20;

export const latestResumableThread = liteAuthQuery
    .input({})
    .output(v.union(v.string(), v.null()))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const { page } = await ctx.db.threads.findMany({
            limit: RESUME_SCAN_LIMIT,
            orderBy: [{ updatedAt: "desc" }],
            where: { userId },
        });

        // `deleted` is unset on ordinary inserts, and unset means live (as in the thread list).
        for (const thread of page) {
            if (thread.deleted || thread.status === "archived" || thread.isTemporary) {
                continue;
            }

            const branch = await ctx.db.threadRelationships.findFirst({ where: { threadId: thread._id } });

            if (!branch) {
                return thread._id as string;
            }
        }

        return null;
    });
