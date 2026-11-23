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

/** Rows the sweep deletes per call. The sweep runs again while it reports more. */
const PRUNE_BATCH = 200;

/** The seq at one end of the user's log, or `undefined` when it is empty. */
const edgeSeq = async (ctx: QueryCtx, userId: string, direction: "asc" | "desc"): Promise<number | undefined> => {
    const row = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: direction }], where: { userId } });

    return row?.seq;
};

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
        latestSeq: async () => (await edgeSeq(ctx, userId, "desc")) ?? 0,
        oldestSeq: async () => await edgeSeq(ctx, userId, "asc"),
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
            maxAgeMs: args.maxAgeMs,
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
 * The retention sweep, run per shard (`shardSweeps()` in `lib/shard-housekeeping.ts`). Deletes events older than the window,
 * but never the highest row of a user's log: the sequence must not restart, or an old cursor would read a new event as one
 * it had already passed.
 */
export const pruneMcpEvents = internalMutation.output(v.object({ hasMore: v.boolean(), removed: v.number() })).mutation(async ({ ctx }) => {
    const cutoff = ctx.now - RETENTION_MS;
    const { page } = await ctx.db.mcpEvents.findMany({ limit: PRUNE_BATCH, where: { createdAt: { lt: cutoff } } });
    let removed = 0;

    for (const row of page) {
        const newest = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: "desc" }], where: { userId: row.userId } });

        if (newest?.seq === row.seq) {
            continue;
        }

        await ctx.db.delete("mcpEvents", row._id);
        removed += 1;
    }

    return { hasMore: page.length === PRUNE_BATCH && removed > 0, removed };
});
