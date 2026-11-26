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

/** Links read to count a person's active watches: a bound, so a long list costs a fixed read. */
const WATCH_COUNT_SCAN = 200;

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
        const links = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_repository_number", (q) => q.eq("userId", args.userId).eq("repository", args.repository).eq("number", args.number))
            .take(WATCH_COUNT_SCAN);
        const link = links.find((row) => String(row.threadId) === args.threadId && row.threadDeleted !== true);

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

        // Counted over the person's links, not per thread: a long list of watches is the cost this bounds.
        const everything = await ctx.db
            .query("pullRequestThreads")
            .withIndex("by_user_and_repository_number", (q) => q.eq("userId", args.userId))
            .take(WATCH_COUNT_SCAN);
        const running = everything.filter((row) => row.watch !== undefined && row.watch.stoppedAt === undefined).length;

        if (running >= MAX_ACTIVE_PULL_REQUEST_WATCHES) {
            return { status: "too_many" as const };
        }

        // The wake count carries over: a restart must not reset the cap that ends a watch which keeps waking.
        await ctx.db.patch("pullRequestThreads", link._id, {
            watch: { startedAt: ctx.now, ...(link.watch?.wakes !== undefined && { wakes: link.watch.wakes }) },
        });

        return { status: "ok" as const };
    });
