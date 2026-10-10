/**
 * Fills the usage rollup (`usageDaily`) from the replies a user had before it
 * existed, once per user, on their own shard.
 *
 * A walk over the user's threads and their messages in bounded steps — each a
 * scheduler job that reads at most {@link BACKFILL_ROWS_PER_STEP} message rows,
 * adds what it found and schedules the next. Its position lives on the user's
 * `usageBackfill` row, advanced in the same mutation as the rollup, so a step
 * that fails or is redelivered repeats nothing.
 *
 * Counted once against the live path (`activity.ts#recordReplyUsage`): the
 * backfill takes only replies started before it did (`startedAt`) and finished,
 * and both sides key a reply on its first row in `usageReplies` — whichever gets
 * there first counts it, the other skips it.
 *
 * Started lazily: when the usage page opens ({@link startUsageBackfill}) and by
 * the shard housekeeping sweep ({@link sweepUsageRollup}), which also picks up a
 * walk whose chain died (its lease ran out) and, once the walk is done, prunes
 * the `usageReplies` keys only redelivery still needs.
 *
 * Threads are paged through `by_userId`, whose key no thread edit changes, so
 * a thread archived, restored or moved mid-walk keeps its place: every thread
 * is walked once. An index that sorts on an editable column (`status`,
 * `deleted`, `order`) would let a thread jump behind the cursor and be missed.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { usageDailyCutoffDate } from "../gdpr/retention";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow } from "../lib/patch";
import { currentUserShard } from "../lib/shard-context";
import type { RollupIncrement } from "./activity-logic";
import { addToRollup, isReplyRecorded, markReplyRecorded } from "./activity";
import type { BackfillRow, BackfillWindow } from "./backfill-logic";
import { backfillIncrement, completeOrders, groupReplies } from "./backfill-logic";

/** Message rows one step reads, at most (plus one oversized `order` read whole). */
export const BACKFILL_ROWS_PER_STEP = 200;

/** Message rows per read inside a step. */
const MESSAGE_PAGE = 100;

/** Threads one step starts, at most — so a user of many empty threads still yields. */
const THREADS_PER_STEP = 25;

/** Rows of one `order` read whole when a page is all that order (a very long agent loop). */
const MAX_ORDER_ROWS = 1000;

/** How long a walk is left to its own chain before a start or the sweep takes it over. */
export const BACKFILL_LEASE_MS = 5 * 60 * 1000;

/** `usageReplies` keys kept past a finished backfill — long enough for any redelivery. */
export const REPLY_KEY_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

/** `threadCursor` once the last thread has been taken. */
const THREADS_END = "end";

/** Keys one sweep prunes. */
const PRUNE_BATCH = 500;

const vBackfillStatus = v.union(v.literal("idle"), v.literal("running"), v.literal("done"));

type BackfillStatus = "done" | "idle" | "running";

type DbCtx = Pick<MutationCtx, "db">;

const loadState = async (ctx: Pick<QueryCtx, "db">, userId: string) => await ctx.db.usageBackfill.findFirst({ where: { userId } });

/**
 * Starts the user's walk, or takes over one whose chain stopped (its position
 * is kept, so it resumes). A walk still within its lease, or finished, is left
 * alone — calling this again is always safe.
 */
export const ensureBackfill = async (ctx: MutationCtx, userId: string, now: number): Promise<Exclude<BackfillStatus, "idle">> => {
    const state = await loadState(ctx, userId);

    if (state?.status === "done") {
        return "done";
    }

    if (state && state.leaseUntil > now) {
        return "running";
    }

    const runId = `${String(now)}:${state ? String(state.replies) : "0"}`;

    if (state) {
        await ctx.db.patch(state._id, { leaseUntil: now + BACKFILL_LEASE_MS, runId, updatedAt: now });
    } else {
        await ctx.db.insert("usageBackfill", {
            leaseUntil: now + BACKFILL_LEASE_MS,
            replies: 0,
            runId,
            startedAt: now,
            status: "running",
            updatedAt: now,
            userId,
        });
    }

    await ctx.scheduler.runAfter(0, internal.usage.backfill.runUsageBackfillStep, { runId, userId });

    return "running";
};

const readThreadRows = async (ctx: DbCtx, threadId: string, afterOrder: number | undefined): Promise<BackfillRow[]> =>
    (await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) =>
            afterOrder === undefined ? q.eq("threadId", threadId as Id<"threads">) : q.eq("threadId", threadId as Id<"threads">).gt("order", afterOrder),
        )
        .take(MESSAGE_PAGE)) as unknown as BackfillRow[];

const readOrderRows = async (ctx: DbCtx, threadId: string, order: number): Promise<BackfillRow[]> =>
    (await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId as Id<"threads">).eq("order", order))
        .take(MAX_ORDER_ROWS)) as unknown as BackfillRow[];

const anyRecorded = async (ctx: DbCtx, userId: string, rows: ReadonlyArray<BackfillRow>): Promise<boolean> => {
    for (const row of rows) {
        if (await isReplyRecorded(ctx, userId, row._id)) {
            return true;
        }
    }

    return false;
};

interface Position {
    lastOrder?: number;
    threadCursor?: string;
    threadId?: string;
}

interface StepResult {
    done: boolean;
    increments: RollupIncrement[];
    /** The first row id of each reply counted. */
    keys: string[];
    position: Position;
}

/** The next thread to walk from `threadCursor`, and the cursor past it; undefined past the last one. */
const nextThread = async (ctx: DbCtx, userId: string, threadCursor: string | undefined): Promise<{ threadCursor: string; threadId: string } | undefined> => {
    if (threadCursor === THREADS_END) {
        return undefined;
    }

    const threads = await ctx.db
        .query("threads")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .paginate({ cursor: threadCursor ?? null, numItems: 1 });
    const [next] = threads.page;

    if (!next) {
        return undefined;
    }

    // A null cursor would start the walk over, so the end is spelled out.
    return { threadCursor: threads.isDone || !threads.continueCursor ? THREADS_END : threads.continueCursor, threadId: next._id as string };
};

/** One read of a thread past `afterOrder`: the rows it can group now, the `order` it covers, and the rows it read. */
const readCompleteRows = async (
    ctx: DbCtx,
    threadId: string,
    afterOrder: number | undefined,
): Promise<{ pageFull: boolean; read: number; rows: ReadonlyArray<BackfillRow>; through: number | undefined }> => {
    const page = await readThreadRows(ctx, threadId, afterOrder);
    const pageFull = page.length === MESSAGE_PAGE;
    const complete = completeOrders(page, pageFull);

    if (complete.splitOrder === undefined) {
        return { pageFull, read: page.length, rows: complete.rows, through: complete.lastOrder };
    }

    const whole = await readOrderRows(ctx, threadId, complete.splitOrder);

    return { pageFull, read: page.length + whole.length, rows: whole, through: complete.splitOrder };
};

/** One step of the walk from `position`: what it counts, and where the next step starts. */
const walk = async (ctx: DbCtx, userId: string, position: Position, window: BackfillWindow): Promise<StepResult> => {
    let { lastOrder, threadCursor, threadId } = position;
    const increments: RollupIncrement[] = [];
    const keys: string[] = [];
    let budget = BACKFILL_ROWS_PER_STEP;
    let threadsStarted = 0;

    while (budget > 0) {
        if (threadId === undefined) {
            if (threadsStarted >= THREADS_PER_STEP) {
                break;
            }

            const next = await nextThread(ctx, userId, threadCursor);

            if (!next) {
                return { done: true, increments, keys, position: {} };
            }

            ({ threadCursor, threadId } = next);
            lastOrder = undefined;
            threadsStarted += 1;
        }

        const { pageFull, read, rows, through } = await readCompleteRows(ctx, threadId, lastOrder);

        budget -= read;

        for (const group of groupReplies(rows)) {
            const increment = backfillIncrement(group, window);

            if (increment && !(await anyRecorded(ctx, userId, group.rows))) {
                increments.push(increment);
                keys.push(group.rows[0]!._id);
            }
        }

        // A short page was the thread's last; a full one continues past `through`.
        lastOrder = pageFull ? through : undefined;
        threadId = pageFull ? threadId : undefined;
    }

    return { done: false, increments, keys, position: { lastOrder, threadCursor, threadId } };
};

/** One step of the user's walk; a step of a replaced chain, or of a finished walk, does nothing. */
export const runUsageBackfillStep = internalMutation
    .input({ runId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { runId, userId }, ctx }) => {
        const state = await loadState(ctx, userId);

        if (state?.status !== "running" || state.runId !== runId) {
            return null;
        }

        // A row written behind the deletion workflow's step would survive the erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const now = ctx.now;
        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });
        const step = await walk(
            ctx,
            userId,
            { lastOrder: state.lastOrder, threadCursor: state.threadCursor, threadId: state.threadId },
            { cutoff: state.startedAt, oldestDate: usageDailyCutoffDate(now), userId, ...(settings?.timezone && { timeZone: settings.timezone }) },
        );

        for (const key of step.keys) {
            await markReplyRecorded(ctx, userId, key, now);
        }

        await addToRollup(ctx, userId, step.increments, now, false);
        await patchRow(ctx.db, state, {
            lastOrder: step.position.lastOrder,
            leaseUntil: now + BACKFILL_LEASE_MS,
            replies: state.replies + step.increments.length,
            threadCursor: step.position.threadCursor,
            threadId: step.position.threadId,
            updatedAt: now,
            ...(step.done && { finishedAt: now, status: "done" as const }),
        });

        if (!step.done) {
            await ctx.scheduler.runAfter(0, internal.usage.backfill.runUsageBackfillStep, { runId, userId });
        }

        return null;
    });

/** Where the caller's backfill stands: `idle` = never started. */
export const getUsageBackfillStatus = authQuery
    .input({})
    .output(vBackfillStatus)
    .query(async ({ ctx }): Promise<BackfillStatus> => {
        const state = await loadState(ctx, ctx.user.userId);

        return state?.status ?? "idle";
    });

/** The usage page opened: start the caller's backfill, or resume one that stopped. */
export const startUsageBackfill = authMutation
    .use(rateLimit("usage/backfill"))
    .input({})
    .output(vBackfillStatus)
    .mutation(async ({ ctx }): Promise<BackfillStatus> => {
        const { userId } = ctx.user;

        if (await isAccountDeletionUnderway(ctx, userId)) {
            return "idle";
        }

        const status = await ensureBackfill(ctx, userId, ctx.now);

        ctx.log.event("usage.start_usage_backfill", { status });

        return status;
    });

/**
 * The shard housekeeping sweep (`lib/shard-housekeeping.ts`), for the user whose
 * shard this is: starts or resumes their backfill, and once it is done prunes
 * the `usageReplies` keys older than {@link REPLY_KEY_KEEP_MS}.
 */
export const sweepUsageRollup = internalMutation
    .input({})
    .output(v.object({ pruned: v.number(), status: vBackfillStatus }))
    .mutation(async ({ ctx }): Promise<{ pruned: number; status: BackfillStatus }> => {
        const userId = currentUserShard();

        if (userId === undefined || (await isAccountDeletionUnderway(ctx, userId))) {
            return { pruned: 0, status: "idle" };
        }

        const now = ctx.now;
        const status = await ensureBackfill(ctx, userId, now);

        if (status !== "done") {
            return { pruned: 0, status };
        }

        const { page } = await ctx.db.usageReplies.findMany({
            limit: PRUNE_BATCH,
            orderBy: [{ recordedAt: "asc" }],
            where: { recordedAt: { lt: now - REPLY_KEY_KEEP_MS } },
        });

        await Promise.all(page.map(async (row) => await ctx.db.delete(row._id)));

        return { pruned: page.length, status };
    });
