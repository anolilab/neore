/**
 * The conversation to reopen for a user who resumes their latest chat: the most
 * recently ACTIVE live thread that is not archived, temporary or a branch.
 *
 * Read by activity (`updatedAt`), not the thread list's creation-time page,
 * and branch status is checked per candidate, so a long history cannot hide
 * the thread the user was last in.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { liteAuthQuery } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

/** Threads read per page, and the most threads a resume will look through. */
const PAGE_SIZE = 50;

/** The fields a resume reads from each thread, and the page cursor. */
interface ScanPage {
    continueCursor: string | null;
    isDone: boolean;
    page: { _id: Id<"threads">; deleted?: boolean; isTemporary?: boolean; organizationId?: string; status: string; teamId?: string }[];
}
const MAX_THREADS_SCANNED = 500;

export const latestResumableThread = liteAuthQuery
    .input({
        // Same scope as the sidebar: null is the personal space; teamId is set only when a team is active.
        organizationId: v.union(v.string().max(MAX_LENGTH.id), v.null()),
        teamId: v.optional(v.string().max(MAX_LENGTH.id)),
    })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }): Promise<string | null> => {
        const { userId } = ctx.user;
        let cursor: string | null = null;

        for (let scanned = 0; scanned < MAX_THREADS_SCANNED; scanned += PAGE_SIZE) {
            const threads: ScanPage = await ctx.db.threads.findMany({
                cursor,
                limit: PAGE_SIZE,
                orderBy: [{ updatedAt: "desc" }],
                where: { userId },
            });

            // `deleted` is unset on ordinary inserts, and unset means live (as in the thread list).
            for (const thread of threads.page) {
                if (thread.deleted || thread.status !== "active" || thread.isTemporary) {
                    continue;
                }

                if ((thread.organizationId ?? null) !== args.organizationId || (args.teamId !== undefined && thread.teamId !== args.teamId)) {
                    continue;
                }

                const branch = await ctx.db.threadRelationships.findFirst({ where: { threadId: thread._id } });

                if (!branch) {
                    return thread._id as string;
                }
            }

            if (threads.isDone || !threads.continueCursor) {
                break;
            }

            cursor = threads.continueCursor;
        }

        return null;
    });
