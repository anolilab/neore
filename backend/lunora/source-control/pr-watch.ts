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
import { internalMutation } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { PR_WATCH_MAX_WAKES, storedWatchOf } from "./pr-watch-logic";

/** Watches one person may have running at once. Each one is a host read every few minutes. */
export const MAX_ACTIVE_PULL_REQUEST_WATCHES = 10;

/** Links read per page when looking a link up by its pull request. */
export const LINK_LOOKUP_PAGE_SIZE = 100;

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
        // Looked up by the pull request's index and paged until this thread's live link is found, so no number of other links
        // to the same pull request (or older links) can hide it.
        const threadId = ctx.db.normalizeId("threads", args.threadId);
        let link: Doc<"pullRequestThreads"> | undefined;
        let cursor: string | null = null;

        while (threadId !== null && link === undefined) {
            const read = await ctx.db
                .query("pullRequestThreads")
                .withIndex("by_user_and_repository_number", (q) => q.eq("userId", args.userId).eq("repository", args.repository).eq("number", args.number))
                .paginate({ cursor, numItems: LINK_LOOKUP_PAGE_SIZE });

            link = read.page.find((row) => row.threadId === threadId && row.threadDeleted !== true);

            if (read.isDone) {
                break;
            }

            cursor = read.continueCursor;
        }

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

        await ctx.db.patch("pullRequestThreads", link._id, { watch: stored.watch, watchActive: true, watchPending: stored.watchPending ?? [] });

        return { status: "ok" as const };
    });
