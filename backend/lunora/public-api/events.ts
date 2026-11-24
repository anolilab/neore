/**
 * The shard side of `events/poll` and the retention sweep. Both are internal: the MCP dispatcher calls `pollEvents` after the
 * key is authenticated and scoped, and on the key owner's shard, so the `userId` it passes is the caller's own.
 *
 * The cursor is decoded and encoded by the router (`router.ts`), where the signing secret lives. These functions speak in
 * seq numbers only.
 */
import { v } from "lunorash/server";

import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { pollEvents as pollLog } from "./events-poll";
import type { EventLogStore } from "./events-poll";
import { RETENTION_MS } from "./events-log";
import { setRetentionDue } from "../lib/shard-housekeeping";

/** Rows the sweep deletes per call. The sweep runs again while it reports more. */
const PRUNE_BATCH = 200;

const storeOn = (ctx: QueryCtx, userId: string): EventLogStore => {
    return {
        after: async (afterSeq, limit) => {
            const { page } = await ctx.db.mcpEvents.findMany({ limit, orderBy: [{ seq: "asc" }], where: { seq: { gt: afterSeq }, userId } });

            return page.map((row) => {
                return {
                    data: JSON.parse(row.data) as Record<string, unknown>,
                    eventId: row.eventId,
                    name: row.name,
                    seq: row.seq,
                    timestamp: row.timestamp,
                };
            });
        },
        latestSeq: async () => {
            const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId } });

            return watermark?.seq ?? 0;
        },
        oldestSeq: async () => {
            const oldest = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: "asc" }], where: { userId } });

            return oldest?.seq;
        },
    };
};

/**
 * One `events/poll`, answered from `userId`'s log. `fromSeq` absent means "start from now": no events, and the log's
 * current end as the position. Errors are the router's: this function does not reject for an unknown name, the router
 * checks the catalog first.
 */
export const pollEvents = internalQuery
    .input({
        fromSeq: v.optional(v.number()),
        maxAgeMs: v.optional(v.number()),
        maxEvents: v.number(),
        name: v.string(),
        threadId: v.optional(v.string()),
        userId: v.string(),
    })
    .output(
        v.object({
            events: v.array(
                v.object({
                    data: v.string(),
                    eventId: v.string(),
                    name: v.string(),
                    timestamp: v.number(),
                }),
            ),
            hasMore: v.boolean(),
            nextSeq: v.number(),
            truncated: v.boolean(),
        }),
    )
    .query(async ({ args, ctx }) => {
        const outcome = await pollLog(storeOn(ctx, args.userId), {
            fromSeq: args.fromSeq ?? null,
            // The window never reaches past retention: an event older than it is expired whether or not housekeeping has pruned it yet,
            // so a dormant shard's backlog is never read back to a returning user.
            maxAgeMs: args.maxAgeMs === undefined ? RETENTION_MS : Math.min(args.maxAgeMs, RETENTION_MS),
            maxEvents: args.maxEvents,
            name: args.name,
            now: ctx.now,
            threadId: args.threadId,
        });

        return {
            events: outcome.events.map((event) => {
                return { ...event, data: JSON.stringify(event.data) };
            }),
            hasMore: outcome.hasMore,
            nextSeq: outcome.nextSeq,
            truncated: outcome.truncated,
        };
    });

/**
 * The retention sweep, run per shard (`runShardHousekeeping` in `lib/shard-housekeeping.ts`). Deletes up to `PRUNE_BATCH`
 * events older than the window, the highest of a log included: the sequence is kept in `mcpEventWatermarks`, so it does not
 * restart. `hasMore` says a full batch was deleted, so the caller calls again.
 */
export const pruneMcpEvents = internalMutation.output(v.object({ hasMore: v.boolean(), removed: v.number() })).mutation(async ({ ctx }) => {
    const cutoff = ctx.now - RETENTION_MS;
    const { page } = await ctx.db.mcpEvents.findMany({ limit: PRUNE_BATCH, where: { createdAt: { lt: cutoff } } });

    for (const row of page) {
        await ctx.db.delete("mcpEvents", row._id);
    }

    const hasMore = page.length === PRUNE_BATCH;
    // The shard's next retention time for this log: now while a full batch was deleted, else the expiry of the oldest event left
    // (none when the log is empty). Without it a shard with no other retained rows would never be woken to expire these.
    const { page: oldest } = await ctx.db.mcpEvents.findMany({ limit: 1, orderBy: [{ createdAt: "asc" }] });

    const next = oldest[0] === undefined ? undefined : oldest[0].createdAt + RETENTION_MS;

    await setRetentionDue(ctx, hasMore ? ctx.now : next);

    return { hasMore, removed: page.length };
});
