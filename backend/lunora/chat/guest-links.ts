/**
 * Guest links: a thread's owner hands out a link, and whoever holds it can LEAVE a message that waits for
 * the owner. Nothing a guest writes runs anything.
 *
 * - A held message is a row in `threadGuestMessages`, not a `messages` row: no agent context, title,
 *   summary or usage job ever reads it.
 * - A link lasts 24 hours and ends sooner when the thread is archived, trashed, deleted, locked or made temporary
 *   (`revokeGuestLinksForThread`); the housekeeping sweep removes the lapsed ones.
 *
 * This file holds the server-side lifecycle only; nothing here is reachable from a client.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation, internalQuery } from "../_generated/server";
import { currentShard, ROOT_SHARD_KEY } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { deleteGuestLink, dropGuestLinkRoutes, GUEST_MAX_ROWS_PER_LINK } from "./lib/guest-link-store";

const SWEEP_BATCH = 50;

const vGuestMessageStatus = v.union(v.literal("held"), v.literal("sent"));

/**
 * A thread's guest notes for the owner's data export (`gdpr/steps.ts#collectConversations`). Bounded by the
 * same per-link cap a guest can fill, so one thread's export never reads more than a link could hold.
 */
export const listGuestNotesForExport = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })))
    .query(async ({ args, ctx }) => {
        const rows = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .take(GUEST_MAX_ROWS_PER_LINK);

        return rows.map((row) => {
            return { createdAt: row.createdAt, status: row.status, text: row.text };
        });
    });

/** Housekeeping sweep (`shardSweeps()`): links past their 24 hours go, with what guests left on them. */
export const sweepGuestLinks = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const lapsed = await ctx.db
            .query("threadGuestLinks")
            .withIndex("by_expiresAt", (q) => q.lte("expiresAt", ctx.now))
            .take(SWEEP_BATCH);
        const routes: string[] = [];

        for (const link of lapsed) {
            routes.push(await deleteGuestLink(ctx, link));
        }

        // The rows went first: a route removed before a failed write would leave a live link unreachable.
        await dropGuestLinkRoutes(ctx, routes);

        // A full batch may have left more behind: carry on now rather than at the shard's next housekeeping.
        if (lapsed.length >= SWEEP_BATCH) {
            // Named, not defaulted: the continuation must stay on this owner's shard.
            await runAfterOnShard(ctx.scheduler, 0, internal.chat.guest_links.sweepGuestLinks, {}, currentShard() ?? ROOT_SHARD_KEY);
        }

        return null;
    });
