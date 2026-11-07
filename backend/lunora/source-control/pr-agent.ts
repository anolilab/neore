/**
 * The pull requests an agent may act on from one thread: those linked to it (#520's `pullRequestThreads`), and no
 * other. Read by the agent's pull request tools (`chat/tools/pull-request.ts`) before every host call, and by the run
 * that decides whether to offer them at all.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { loadEligibleThread } from "../devices/internal";
import { MAX_LENGTH } from "../lib/validators";
import { partitionLinks } from "./pr-threads";

/** Link rows read per page; a thread's links and a pull request's links are paged to the end. */
const LINK_PAGE_SIZE = 100;
/** Pages of a thread's links one read goes through: far past what any thread holds, a bound and not a filter. */
const MAX_LINK_PAGES = 20;

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
    .output(v.object({ complete: v.boolean(), links: v.array(vLinkedPullRequest) }))
    .query(async ({ args, ctx }) => {
        // Only a thread the tools may run in has links an agent can see (`pullRequestToolsAllowed`).
        const thread = await loadEligibleThread(ctx, args.threadId as Id<"threads">, args.userId);

        if (!thread) {
            return { complete: true, links: [] };
        }

        const rows: Doc<"pullRequestThreads">[] = [];
        let cursor: string | null = null;
        // Past the page bound the list is a part: said so, and a lookup then asks for repository and number (keyed).
        let complete = false;

        for (let page = 0; page < MAX_LINK_PAGES; page += 1) {
            const read = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_threadId", (q) => q.eq("userId", args.userId).eq("threadId", thread._id))
                .paginate({ cursor, numItems: LINK_PAGE_SIZE });

            rows.push(...read.page);

            if (read.isDone) {
                complete = true;
                break;
            }

            cursor = read.continueCursor;
        }

        const { live } = await partitionLinks(ctx, rows);
        const seen = new Set<string>();

        const links = live
            .toSorted((left, right) => right.createdAt - left.createdAt || right._id.localeCompare(left._id))
            .flatMap((row) => {
                const key = `${row.repository}#${String(row.number)}`;

                if (seen.has(key)) {
                    return [];
                }

                seen.add(key);

                return [{ kind: row.kind, number: row.number, repository: row.repository }];
            });

        return { complete, links };
    });

/**
 * Whether one pull request is linked to the thread, read by its key (user, repository, number) rather than from the
 * thread's capped list, so a thread with many links still finds each of them. The thread must be the user's and live.
 */
export const isPullRequestLinkedToThread = internalQuery
    .input({
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.key),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.boolean())
    .query(async ({ args, ctx }) => {
        const thread = await loadEligibleThread(ctx, args.threadId as Id<"threads">, args.userId);

        if (!thread) {
            return false;
        }

        // Every link of the pull request is looked at, page by page, so many links to it never hide this thread's.
        let cursor: string | null = null;

        for (;;) {
            const read = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_repository_number", (q) => q.eq("userId", args.userId).eq("repository", args.repository).eq("number", args.number))
                .paginate({ cursor, numItems: LINK_PAGE_SIZE });

            if (read.page.some((link) => link.threadId === thread._id)) {
                return true;
            }

            if (read.isDone) {
                return false;
            }

            cursor = read.continueCursor;
        }
    });

/**
 * Whether an agent run in this thread may use the pull request tools at all: the thread is the user's own, live, and
 * used by them alone (not a group, not public, not an outside chat, nobody granted access). The same rule device
 * tools keep (`isDeviceEligibleThread`): the tools read and act with the owner's connection, so nobody else may steer
 * them or see what they read. Checked when a tool RUNS, whatever put the tool in the run (a skill, an approval).
 */
export const pullRequestToolsAllowed = internalQuery
    .input({ threadId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args, ctx }) => (await loadEligibleThread(ctx, args.threadId as Id<"threads">, args.userId)) !== null);
