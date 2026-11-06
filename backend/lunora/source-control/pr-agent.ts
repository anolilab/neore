/**
 * The pull requests an agent may act on from one thread: those linked to it (#520's `pullRequestThreads`), and no
 * other. Read by the agent's pull request tools (`chat/tools/pull-request.ts`) before every host call, and by the run
 * that decides whether to offer them at all.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { partitionLinks } from "./pr-threads";

/** Link rows read for one thread: the thread list's own read bound (`pr-thread-attach.ts`). */
const MAX_LINKS_READ = 100;

const vLinkedPullRequest = v.object({
    kind: v.union(v.literal("attached"), v.literal("linked"), v.literal("opened")),
    number: v.number(),
    repository: v.string(),
});

/**
 * Every live pull request linked to the thread, one entry each, newest link first. Empty for a thread that is not the
 * user's or is deleted: nothing is linked to it as far as an agent is concerned.
 */
export const linkedPullRequestsOfThread = internalQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.array(vLinkedPullRequest))
    .query(async ({ args, ctx }) => {
        const thread = await ctx.db.get("threads", args.threadId as Id<"threads">);

        if (!thread || thread.deleted === true || thread.userId !== args.userId) {
            return [];
        }

        const rows = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_threadId", (q) => q.eq("userId", args.userId).eq("threadId", thread._id))
            .take(MAX_LINKS_READ);
        const { live } = await partitionLinks(ctx, rows);
        const seen = new Set<string>();

        return live
            .toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id))
            .flatMap((row) => {
                const key = `${row.repository}#${String(row.number)}`;

                if (seen.has(key)) {
                    return [];
                }

                seen.add(key);

                return [{ kind: row.kind, number: row.number, repository: row.repository }];
            });
    });
