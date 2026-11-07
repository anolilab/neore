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
 * A second walk over the same threads ({@link runUsageProjectBackfillStep})
 * files the replies the rollup counted before it knew about projects under
 * their thread's project (only threads that are still in one). It adds project
 * rows and nothing else, so it never moves the totals; it shares the first
 * walk's window and grouping, keeps its own position on the same row, and
 * counts a reply once against the live path: the live record marks its key
 * `projectFiled`, the walk marks `project:<key>`, and each skips what the other
 * marked. It takes only replies from before the first walk's cutoff, which the
 * total provably holds; later history stays under "No project", so the
 * projects never add up to more than the total. Keys are pruned only once both
 * walks are done.
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
import type { Attribution, AttributionIncrement, RollupIncrement } from "./activity-logic";
import { pendingKey, projectFiledKey } from "./activity-logic";
import { addToAttributionRollup, addToRollup, isReplyRecorded, markReplyRecorded } from "./activity";
import type { BackfillRow, BackfillWindow, ReplyGroup } from "./backfill-logic";
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

type BackfillState = NonNullable<Awaited<ReturnType<typeof loadState>>>;

/**
 * Each walk on its own: the first walk changes the totals and skills, the project walk only the project rows, so a
 * page waits only on the walk that feeds it. `idle` = not started.
 */
const walkStatuses = (state: BackfillState | null): { projects: BackfillStatus; replies: BackfillStatus } => {
    return { projects: state?.projects?.status ?? "idle", replies: state?.status ?? "idle" };
};

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
        await ctx.db.patch("usageBackfill", state._id, { leaseUntil: now + BACKFILL_LEASE_MS, runId, updatedAt: now });
    } else {
        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });

        await ctx.db.insert("usageBackfill", {
            leaseUntil: now + BACKFILL_LEASE_MS,
            replies: 0,
            runId,
            startedAt: now,
            status: "running",
            // Both walks date a reply in this zone, so a later change of zone cannot put a reply's project row and its
            // total on different days. No zone yet is UTC, recorded as such so a zone set later changes nothing.
            timeZone: settings?.timezone || "UTC",
            updatedAt: now,
            userId,
        });
    }

    await ctx.scheduler.runAfter(0, internal.usage.backfill.runUsageBackfillStep, { runId, userId });

    return "running";
};

/**
 * Starts the user's project walk, or takes over one whose chain stopped — the
 * same rules as {@link ensureBackfill}, whose row it needs (call that first).
 */
export const ensureProjectBackfill = async (ctx: MutationCtx, userId: string, now: number): Promise<Exclude<BackfillStatus, "idle">> => {
    const state = await loadState(ctx, userId);

    if (!state) {
        return "running";
    }

    const walk = state.projects;

    if (walk?.status === "done") {
        return "done";
    }

    if (walk && walk.leaseUntil > now) {
        return "running";
    }

    const runId = `${String(now)}:${walk ? String(walk.replies) : "0"}`;

    await ctx.db.patch("usageBackfill", state._id, {
        projects: walk
            ? { ...walk, leaseUntil: now + BACKFILL_LEASE_MS, runId }
            : { leaseUntil: now + BACKFILL_LEASE_MS, replies: 0, runId, startedAt: now, status: "running" as const },
        updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.usage.backfill.runUsageProjectBackfillStep, { runId, userId });

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

interface StepResult<I> {
    done: boolean;
    increments: I[];
    /** The first row id of each reply counted. */
    keys: string[];
    position: Position;
}

interface WalkedThread {
    projectId?: string;
    threadCursor: string;
    threadId: string;
}

/**
 * What one walk does with a reply group of a thread: the increment it adds, or
 * undefined to leave it. `skipThread` lets a walk pass a thread without reading it.
 */
interface WalkPass<I> {
    count: (group: ReplyGroup, thread: Attribution) => Promise<I | undefined>;
    /** Set by a walk that needs each thread's attribution (read once per thread); it may then pass a thread unread. */
    skipThread?: (thread: Attribution) => boolean;
}

/**
 * What the project walk files a past reply under: its thread's project, and no organization. Nothing records which
 * organization a thread or project was in when a past reply ran, and filing it under the one it is in now could show
 * one organization's spend to another's admins; organization totals start with the live record.
 */
const projectOnly = (thread: { projectId?: string | null } | null): Attribution => (thread?.projectId ? { projectKey: thread.projectId } : {});

/** The next thread to walk from `threadCursor`, and the cursor past it; undefined past the last one. */
const nextThread = async (ctx: DbCtx, userId: string, threadCursor: string | undefined): Promise<WalkedThread | undefined> => {
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
    return {
        threadCursor: threads.isDone || !threads.continueCursor ? THREADS_END : threads.continueCursor,
        threadId: next._id as string,
        ...(next.projectId && { projectId: next.projectId as string }),
    };
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

/** One step of a walk from `position`: what it counts, and where the next step starts. */
const walk = async <I>(ctx: DbCtx, userId: string, position: Position, pass: WalkPass<I>): Promise<StepResult<I>> => {
    let { lastOrder, threadCursor, threadId } = position;
    let thread: Attribution = {};
    const increments: I[] = [];
    const keys: string[] = [];
    let budget = BACKFILL_ROWS_PER_STEP;
    let threadsStarted = 0;

    if (threadId !== undefined && pass.skipThread) {
        thread = projectOnly(await ctx.db.threads.findFirst({ where: { _id: threadId as Id<"threads"> } }));
    }

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
            thread = pass.skipThread ? projectOnly(next) : {};
            lastOrder = undefined;
            threadsStarted += 1;

            if (pass.skipThread?.(thread)) {
                threadId = undefined;
                continue;
            }
        }

        const { pageFull, read, rows, through } = await readCompleteRows(ctx, threadId, lastOrder);

        budget -= read;

        for (const group of groupReplies(rows)) {
            const increment = await pass.count(group, thread);

            if (increment !== undefined) {
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

/**
 * The window a walk step counts in. Days are reckoned in the zone the first walk started with, so both walks date a
 * reply alike; a walk started before that snapshot existed falls back to the user's zone now.
 */
const windowFor = async (ctx: DbCtx, userId: string, cutoff: number, now: number, snapshot: string | undefined): Promise<BackfillWindow> => {
    const settings = snapshot === undefined ? await ctx.db.userSettings.findFirst({ where: { userId } }) : null;
    const timeZone = snapshot ?? settings?.timezone ?? undefined;

    return { cutoff, oldestDate: usageDailyCutoffDate(now), userId, ...(timeZone && { timeZone }) };
};

/** Whether the live path filed any of these rows' reply under its project itself. */
const anyProjectFiled = async (ctx: DbCtx, userId: string, rows: ReadonlyArray<BackfillRow>): Promise<boolean> => {
    for (const row of rows) {
        const recorded = await ctx.db.usageReplies.findFirst({ where: { replyKey: row._id, userId } });

        if (recorded?.projectFiled) {
            return true;
        }
    }

    return false;
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

        const { now } = ctx;
        const window = await windowFor(ctx, userId, state.startedAt, now, state.timeZone ?? undefined);
        const step = await walk<RollupIncrement>(
            ctx,
            userId,
            { lastOrder: state.lastOrder, threadCursor: state.threadCursor, threadId: state.threadId },
            {
                count: async (group) => {
                    const increment = backfillIncrement(group, window);
                    const first = group.rows[0];

                    // A reply still running here is left to its live record; the project walk must know it skipped it.
                    if (!increment && first && first._creationTime < window.cutoff && group.rows.some((row) => row.status === "pending")) {
                        if (!(await isReplyRecorded(ctx, userId, pendingKey(first._id)))) {
                            await markReplyRecorded(ctx, userId, pendingKey(first._id), now);
                        }

                        return undefined;
                    }

                    return increment && !(await anyRecorded(ctx, userId, group.rows)) ? increment : undefined;
                },
            },
        );

        for (const key of step.keys) {
            await markReplyRecorded(ctx, userId, key, now);
        }

        await addToRollup(ctx, userId, step.increments, now, false);
        await patchRow(ctx.db, "usageBackfill", state, {
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

/**
 * One step of the user's project walk: files the finished replies of threads
 * still in a project, from before the walk started, under that project — unless
 * the live path or an earlier step already did. A step of a replaced chain, or
 * of a finished walk, does nothing.
 */
export const runUsageProjectBackfillStep = internalMutation
    .input({ runId: v.string(), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { runId, userId }, ctx }) => {
        const state = await loadState(ctx, userId);
        const position = state?.projects;

        if (!state || position?.status !== "running" || position.runId !== runId) {
            return null;
        }

        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const { now } = ctx;
        // Only replies from before the first walk's cutoff: that walk (or the live record) counted each of them in the
        // total. A later one is in the total only if its live record landed, which nothing durable says once its key
        // is pruned, so it stays under "No project" rather than risk projects adding up to more than the total.
        const window = await windowFor(ctx, userId, Math.min(state.startedAt, position.startedAt), now, state.timeZone ?? undefined);
        const step = await walk<AttributionIncrement>(
            ctx,
            userId,
            { lastOrder: position.lastOrder, threadCursor: position.threadCursor, threadId: position.threadId },
            {
                count: async (group, thread) => {
                    const increment = backfillIncrement(group, window);
                    const key = group.rows[0]?._id;

                    if (!increment || key === undefined || thread.projectKey === undefined) {
                        return undefined;
                    }

                    if ((await isReplyRecorded(ctx, userId, projectFiledKey(key))) || (await anyProjectFiled(ctx, userId, group.rows))) {
                        return undefined;
                    }

                    // A reply the first walk skipped as still running (it marked it), or one still writing rows after that walk
                    // started, is counted in the total only by its live record. File it only once that record has landed (its
                    // key is held): a record that never landed must not leave a project row with no total.
                    const reliesOnLiveRecord =
                        (await isReplyRecorded(ctx, userId, pendingKey(key))) || group.rows.some((row) => row._creationTime >= state.startedAt);

                    if (reliesOnLiveRecord && !(await anyRecorded(ctx, userId, group.rows))) {
                        return undefined;
                    }

                    return {
                        costMicrodollars: increment.costMicrodollars,
                        date: increment.date,
                        projectKey: thread.projectKey,
                        replies: increment.replies,
                        tokens: increment.tokens,
                    };
                },
                skipThread: (thread) => thread.projectKey === undefined,
            },
        );

        for (const key of step.keys) {
            await markReplyRecorded(ctx, userId, projectFiledKey(key), now);
        }

        await addToAttributionRollup(ctx, userId, step.increments, now);
        await ctx.db.patch("usageBackfill", state._id, {
            projects: {
                leaseUntil: now + BACKFILL_LEASE_MS,
                replies: position.replies + step.increments.length,
                runId: position.runId,
                startedAt: position.startedAt,
                status: step.done ? ("done" as const) : ("running" as const),
                ...(step.position.lastOrder !== undefined && { lastOrder: step.position.lastOrder }),
                ...(step.position.threadCursor !== undefined && { threadCursor: step.position.threadCursor }),
                ...(step.position.threadId !== undefined && { threadId: step.position.threadId }),
                ...(step.done && { finishedAt: now }),
            },
            updatedAt: now,
        });

        if (!step.done) {
            await ctx.scheduler.runAfter(0, internal.usage.backfill.runUsageProjectBackfillStep, { runId, userId });
        }

        return null;
    });

/**
 * Where the caller's first walk stands: `idle` = not started. Kept to its old shape for pages loaded before the project
 * walk existed; current pages read {@link getUsageBackfillStatuses}.
 */
export const getUsageBackfillStatus = authQuery
    .input({})
    .output(vBackfillStatus)
    .query(async ({ ctx }): Promise<BackfillStatus> => walkStatuses(await loadState(ctx, ctx.user.userId)).replies);

/** Where each of the caller's two walks stands: `idle` = not started. */
export const getUsageBackfillStatuses = authQuery
    .input({})
    .output(v.object({ projects: vBackfillStatus, replies: vBackfillStatus }))
    .query(async ({ ctx }) => walkStatuses(await loadState(ctx, ctx.user.userId)));

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

        const replies = await ensureBackfill(ctx, userId, ctx.now);
        const projects = await ensureProjectBackfill(ctx, userId, ctx.now);
        const status = replies === "done" && projects === "done" ? "done" : "running";

        ctx.log.event("usage.start_usage_backfill", { projects, status });

        return status;
    });

/**
 * The shard housekeeping sweep (`lib/shard-housekeeping.ts`), for the user whose
 * shard this is: starts or resumes both walks, and once both are done prunes
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

        const { now } = ctx;
        const replies = await ensureBackfill(ctx, userId, now);
        const projects = await ensureProjectBackfill(ctx, userId, now);
        const status = replies === "done" && projects === "done" ? "done" : "running";

        // Both walks check these keys: they stay until neither still needs them.
        if (status !== "done") {
            return { pruned: 0, status };
        }

        const { page } = await ctx.db.usageReplies.findMany({
            limit: PRUNE_BATCH,
            orderBy: [{ recordedAt: "asc" }],
            where: { recordedAt: { lt: now - REPLY_KEY_KEEP_MS } },
        });

        await Promise.all(page.map(async (row) => await ctx.db.delete("usageReplies", row._id)));

        return { pruned: page.length, status };
    });
