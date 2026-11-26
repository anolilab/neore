/**
 * Starts and stops a pull request watch on a linked thread: the thread is woken when the pull request fails checks,
 * conflicts or gets a review (`pr-watch-logic.ts` decides which). This file only records the request. Reading the host
 * and waking the thread are separate steps, so a watch that is started here waits for those.
 *
 * Starting a watch takes a fresh baseline: whatever the pull request looks like at the first read is recorded, not
 * reported. A stopped watch keeps its row (`stoppedAt`), so a restart is a new baseline, never a replay of old wakes.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";

/** Watches one person may have running at once. Each one is a host read every few minutes. */
export const MAX_ACTIVE_PULL_REQUEST_WATCHES = 10;

/** Links read per page when counting a person's active watches. Pages are read until the count is final or the bound is hit. */
const WATCH_COUNT_PAGE_SIZE = 100;
const WATCH_COUNT_MAX_PAGES = 50;

export const setPullRequestWatch = internalMutation
    .input({
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.short),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
        watching: v.boolean(),
    })
    .output(v.object({ status: v.union(v.literal("already"), v.literal("not_linked"), v.literal("ok"), v.literal("too_many")) }))
    .mutation(async ({ args, ctx }) => {
        // Looked up by the thread, so no number of other links to the same pull request can push this one out of reach.
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const links =
            threadId === null
                ? []
                : await ctx.db
                      .query("pullRequestThreads")
                      .withIndex("by_user_and_threadId", (q) => q.eq("userId", args.userId).eq("threadId", threadId))
                      .take(MAX_ACTIVE_PULL_REQUEST_WATCHES * 10);
        const link = links.find((row) => row.repository === args.repository && row.number === args.number && row.threadDeleted !== true);

        if (link === undefined) {
            return { status: "not_linked" as const };
        }

        const active = link.watch !== undefined && link.watch.stoppedAt === undefined;

        if (!args.watching) {
            if (!active || link.watch === undefined) {
                return { status: "already" as const };
            }

            await ctx.db.patch("pullRequestThreads", link._id, { watch: { ...link.watch, stoppedAt: ctx.now } });

            return { status: "ok" as const };
        }

        if (active) {
            return { status: "already" as const };
        }

        // Counted over every page of the person's links, up to a bound, and only links whose thread is live.
        let running = 0;
        let cursor: string | null = null;

        for (let page = 0; page < WATCH_COUNT_MAX_PAGES && running < MAX_ACTIVE_PULL_REQUEST_WATCHES; page += 1) {
            const read = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_repository_number", (q) => q.eq("userId", args.userId))
                .paginate({ cursor, numItems: WATCH_COUNT_PAGE_SIZE });

            running += read.page.filter((row) => row.watch !== undefined && row.watch.stoppedAt === undefined && row.threadDeleted !== true).length;

            if (read.isDone) {
                break;
            }

            cursor = read.continueCursor;
        }

        if (running >= MAX_ACTIVE_PULL_REQUEST_WATCHES) {
            return { status: "too_many" as const };
        }

        // The wake count carries over: a restart must not reset the cap that ends a watch which keeps waking.
        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: { startedAt: ctx.now, ...(link.watch?.wakes !== undefined && { wakes: link.watch.wakes }) },
            watchPending: [],
        });

        return { status: "ok" as const };
    });
