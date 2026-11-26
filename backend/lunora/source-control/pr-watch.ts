/**
 * Starts and stops a pull request watch on a linked thread: the thread is woken when the pull request fails checks,
 * conflicts or gets a review (`pr-watch-logic.ts` decides which). This file only records the request. Reading the host
 * and waking the thread are separate steps, so a watch that is started here waits for those.
 *
 * Starting a watch takes a fresh baseline: whatever the pull request looks like at the first read is recorded, not
 * reported. A stopped watch keeps its row (`stoppedAt`), so a restart is a new baseline, never a replay of old wakes.
 *
 * `watchActive` (indexed) is true exactly while a watch runs, and the person's limit counts it. Anything that ends a
 * watch must clear it with `stoppedAt`: the stop here, a thread's soft delete (`pr-thread-links.ts`), and the future
 * caller that acts on a decision of "end".
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation } from "../_generated/server";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { PR_WATCH_MAX_WAKES, storedWatchOf } from "./pr-watch-logic";

/** Watches one person may have running at once. Each one is a host read every few minutes. */
export const MAX_ACTIVE_PULL_REQUEST_WATCHES = 10;

/** Newest rows read for one thread's links to one pull request: a live link and the deleted ones newer than it. */
const LINK_LOOKUP_BOUND = 20;

export const setPullRequestWatch = internalMutation
    .input({
        number: v.number(),
        repository: v.string().max(MAX_LENGTH.short),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
        watching: v.boolean(),
    })
    .output(v.object({ status: v.union(v.literal("already"), v.literal("capped"), v.literal("not_linked"), v.literal("ok"), v.literal("too_many")) }))
    .mutation(async ({ args, ctx }) => {
        // One exact, bounded read: the newest rows of the person's links of this thread to this pull request. Deleted rows are
        // skipped. Should several live rows match (a run can open a second link), the one holding a running watch wins, so a
        // stop always reaches it; otherwise the newest live row. Creation time, then id, orders them whatever order the index returned.
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        const rows =
            threadId === null
                ? []
                : await ctx.db
                      .query("pullRequestThreads")
                      .withIndex("by_user_and_repository_number_threadId", (q) =>
                          q.eq("userId", args.userId).eq("repository", args.repository).eq("number", args.number).eq("threadId", threadId),
                      )
                      .order("desc")
                      .take(LINK_LOOKUP_BOUND);
        const live = rows.filter((row) => row.threadDeleted !== true).toSorted((a, b) => b._creationTime - a._creationTime || (a._id < b._id ? 1 : -1));
        const link: Doc<"pullRequestThreads"> | undefined = live.find((row) => row.watch !== undefined && row.watch.stoppedAt === undefined) ?? live[0];

        if (link === undefined) {
            return { status: "not_linked" as const };
        }

        const active = link.watch !== undefined && link.watch.stoppedAt === undefined;

        if (!args.watching) {
            if (!active || link.watch === undefined) {
                return { status: "already" as const };
            }

            await ctx.db.patch("pullRequestThreads", link._id, { watch: { ...link.watch, stoppedAt: ctx.now }, watchActive: false });

            return { status: "ok" as const };
        }

        if (active) {
            return { status: "already" as const };
        }

        // Exact and bounded: the flag is kept in step with every start and stop, and only live threads' watches carry it.
        const running = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_watchActive", (q) => q.eq("userId", args.userId).eq("watchActive", true))
            .take(MAX_ACTIVE_PULL_REQUEST_WATCHES);

        if (running.length >= MAX_ACTIVE_PULL_REQUEST_WATCHES) {
            return { status: "too_many" as const };
        }

        const carried = link.watch?.wakes ?? 0;

        // A watch that reached its wake cap is over: restarting it would only end it on its next read.
        if (carried >= PR_WATCH_MAX_WAKES) {
            return { status: "capped" as const };
        }

        // The wake count carries over: a restart must not reset the cap that ends a watch which keeps waking.
        const stored = storedWatchOf({ startedAt: ctx.now, ...(link.watch?.wakes !== undefined && { wakes: link.watch.wakes }) });

        // A fresh watch is never inside an old watch's read interval (`watchCheckedAt` 0), and its own poll chain starts now.
        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: stored.watch,
            watchActive: true,
            watchCheckedAt: 0,
            watchPending: stored.watchPending ?? [],
        });
        await runAfterOnShard(ctx.scheduler, 0, internal.source_control.pr_watch_poll.pollWatchLink, { linkId: link._id }, args.userId);

        return { status: "ok" as const };
    });
