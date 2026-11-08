/**
 * Guest links: a thread's owner hands out a link, and whoever holds it can LEAVE a message that waits for
 * the owner. Nothing a guest writes runs anything.
 *
 * - A held message is a row in `threadGuestMessages`, not a `messages` row: no agent context, title,
 *   summary or usage job ever reads it.
 * - A link lasts 24 hours and ends sooner when the thread is archived, trashed, deleted, locked or made temporary
 *   (`withdrawGuestLinksForThread`); the housekeeping sweep removes the lapsed ones.
 *
 * This file holds the server-side lifecycle only; nothing here is reachable from a client.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalMutation, internalQuery } from "../_generated/server";
import { currentShard, ROOT_SHARD_KEY } from "../lib/shard-context";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { deleteGuestLink, dropGuestLinkRoutes, withdrawGuestLinksForThread } from "./lib/guest-link-store";

const SWEEP_BATCH = 50;

/** Notes per export page. */
const EXPORT_PAGE = 100;

const vGuestMessageStatus = v.union(v.literal("held"), v.literal("sent"));

/**
 * One page of a thread's guest notes for the owner's data export (`gdpr/steps.ts#collectConversations`), which reads
 * pages until `isDone`.
 */
export const listGuestNotesForExport = internalQuery
    .input({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), threadId: v.id("threads") })
    .output(
        v.object({
            continueCursor: v.union(v.string(), v.null()),
            isDone: v.boolean(),
            page: v.array(v.object({ createdAt: v.number(), status: vGuestMessageStatus, text: v.string() })),
        }),
    )
    .query(async ({ args, ctx }) => {
        const result = await ctx.db
            .query("threadGuestMessages")
            .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
            .paginate({ cursor: args.cursor, numItems: EXPORT_PAGE });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            page: result.page.map((row) => {
                return { createdAt: row.createdAt, status: row.status, text: row.text };
            }),
        };
    });

/** The rest of a thread's guest links after a write that removed only the first batch (`withdrawGuestLinksForThread`). */
export const continueGuestLinkRemoval = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await withdrawGuestLinksForThread(ctx, args.threadId);

        return null;
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
        let unfinished = false;

        for (const link of lapsed) {
            const hash = await deleteGuestLink(ctx, link);

            // A link with more messages than one page keeps its row; the continuation below finishes it.
            if (hash === undefined) {
                unfinished = true;
                break;
            }

            routes.push(hash);
        }

        // The rows went first: a route removed before a failed write would leave a live link unreachable.
        await dropGuestLinkRoutes(ctx, routes);

        // A full batch or an unfinished link may have left more behind: carry on now rather than at the shard's next housekeeping.
        if (unfinished || lapsed.length >= SWEEP_BATCH) {
            // Named, not defaulted: the continuation must stay on this owner's shard.
            await runAfterOnShard(ctx.scheduler, 0, internal.chat.guest_links.sweepGuestLinks, {}, currentShard() ?? ROOT_SHARD_KEY);
        }

        return null;
    });
