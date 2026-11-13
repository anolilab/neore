/**
 * Erasure, cleanup and retention of the usage tables: `usageDaily`, `usageReplies`, `usageBackfill`, and the export's pieces
 * (`usageExportPieces`), project index (`usageExportProjects`) and runs (`usageExportRuns`), owned by the usage module.
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's transaction. Typed ids only: an `Id<TableName>` would
 * read as a write to every table. A failed delete throws, so its erasure step fails, and the retry finishes what is left.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { BATCH, full, type BatchResult } from "../gdpr/batch";
import { isExportRequestInFlight } from "../gdpr/export-requests";
import { patchRow } from "../lib/patch";
import { noteShardDue } from "../lib/shard-housekeeping";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { RECORD_RETRY } from "./activity-logic";

/**
 * Pieces one erasure, clear or sweep step reads. A rows piece holds up to a thousand exported rows, so a step's read stays bounded
 * by this count, not by the size of a user's whole export. A full batch means more may remain: the caller runs again.
 */
export const EXPORT_PIECE_BATCH = 10;

/** Whether a batch of export pieces came back full, so that more may remain. */
const fullPieces = (pieces: ReadonlyArray<unknown>): boolean => pieces.length >= EXPORT_PIECE_BATCH;

/**
 * How long a run may live without its request being pending or processing before the sweep removes it. A run finishes in minutes and
 * clears itself, so a run still pending or processing past this is one the sweep leaves alone: it is still live.
 */
export const EXPORT_PIECE_TTL_MS = 24 * 60 * 60 * 1000;

/** Pages of a user's run rows one erasure call reads; the next call continues where this one stopped. */
const RUN_PAGES_PER_ERASURE = 50;

/**
 * Schedules the purge of a run's usage object (`purgeUsageFile`). The purge runs on the user's shard and is retried by the scheduler,
 * unlike the shared storage cleanup, which swallows a failed delete. The run's record stays until the object is gone, so a purge that
 * keeps failing is found again by the sweep.
 */
const schedulePurge = async (ctx: MutationCtx, run: { _id: Id<"usageExportRuns">; usageKey?: string; userId: string }): Promise<void> => {
    if (run.usageKey === undefined) {
        return;
    }

    await runAfterOnShard(ctx.scheduler, 0, internal.usage.gdpr.purgeUsageFile, { key: run.usageKey, runId: run._id }, run.userId, RECORD_RETRY);
};

/**
 * Removes a run's usage object, then releases its record. A delete that fails throws, so the scheduler retries the purge, and the
 * record is kept for the sweep to retry from.
 */
export const purgeUsageFile = internalAction
    .input({ key: v.string().max(MAX_LENGTH.key), runId: v.id("usageExportRuns") })
    .output(v.null())
    .action(async ({ args: { key, runId }, ctx }) => {
        await purgeObject(ctx.storage, key, async () => await ctx.runMutation(internal.usage.gdpr.releaseUsageKey, { runId }));

        return null;
    });

/**
 * The purge's two steps: the object is deleted, then the run is released. A delete that throws stops here, so the release never runs
 * for an object still in storage.
 */
export const purgeObject = async (
    storage: { delete: (key: string) => Promise<unknown>; getMetadata: (key: string) => Promise<unknown> },
    key: string,
    release: () => Promise<unknown>,
): Promise<void> => {
    if (await storage.getMetadata(key)) {
        await storage.delete(key);
    }

    await release();
};

/**
 * Releases a run's record once its object is gone: the key is cleared, and the row removed when no piece and no index row of the run
 * is left. A run still holding either keeps its row, so the sweep can finish them.
 */
export const releaseUsageKey = internalMutation
    .input({ runId: v.id("usageExportRuns") })
    .output(v.null())
    .mutation(async ({ args: { runId }, ctx }) => {
        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { _id: runId } });

        if (!run) {
            return null;
        }

        const piece = await ctx.db.usageExportPieces.findFirst({
            consistency: "primary",
            where: { requestId: run.requestId, userId: run.userId },
        });
        const project = await ctx.db.usageExportProjects.findFirst({
            consistency: "primary",
            where: { requestId: run.requestId, userId: run.userId },
        });

        if (piece || project) {
            await patchRow(ctx.db, "usageExportRuns", run, { usageKey: undefined });
        } else {
            await ctx.db.delete("usageExportRuns", run._id);
        }

        return null;
    });

/**
 * One batch of the user's rollup and export tables: the per-day rollup (`usageDaily`), the keys of the replies it counted
 * (`usageReplies`), the backfill's position (`usageBackfill`), the export's pieces, project index and run rows. `hasMore` while any
 * batch came back full. A failed delete throws: the erasure step fails, and its retry finds what is left, so it never reports done
 * early. A run row with an object is kept: its purge removes the object and then the row.
 *
 * `runCursor` is the run scan's position: `undefined` starts the scan, a string continues it, and `null` means it has finished, so the
 * later batches of the same erasure do not rescan the run rows.
 */
export const eraseUsageForUser = async (ctx: MutationCtx, userId: string, runCursor?: string | null): Promise<BatchResult & { runCursor: string | null }> => {
    const [days, keys, backfills, pieces, projects] = await Promise.all([
        ctx.db
            .query("usageDaily")
            .withIndex("by_user_date", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageReplies")
            .withIndex("by_user_reply", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageBackfill")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db.usageExportPieces.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { userId } }),
        ctx.db.usageExportProjects.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { userId } }),
    ]);

    await Promise.all([
        ...days.map(async (row) => await ctx.db.delete("usageDaily", row._id)),
        ...keys.map(async (row) => await ctx.db.delete("usageReplies", row._id)),
        ...backfills.map(async (row) => await ctx.db.delete("usageBackfill", row._id)),
        ...pieces.page.map(async (row) => await ctx.db.delete("usageExportPieces", row._id)),
        ...projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)),
    ]);

    // A run with an object keeps its row: the erasure's purge step deletes the object, then releases the row, so the erasure is not
    // done while an object remains. A run without one is removed wherever it sits. The scan carries its position from one call to the
    // next, so keyed runs, however many, cannot hide an unkeyed run behind them.
    const runsAt = (cursor: string | null) => ctx.db.usageExportRuns.findMany({ consistency: "primary", cursor, limit: EXPORT_PIECE_BATCH, where: { userId } });
    let cursor: string | null | undefined = runCursor;

    for (let pages = 0; cursor !== null && pages < RUN_PAGES_PER_ERASURE; pages += 1) {
        const runs = await runsAt(cursor ?? null);

        for (const run of runs.page) {
            if (run.usageKey !== undefined) {
                continue;
            }

            // A live run keeps its record: its export has not ended, and the sweep removes the record once it has.
            if (await isRunLive(ctx, run.requestId, userId)) {
                continue;
            }

            await ctx.db.delete("usageExportRuns", run._id);
        }

        cursor = runs.isDone ? null : runs.continueCursor;
    }

    return {
        hasMore: full(days) || full(keys) || full(backfills) || fullPieces(pieces.page) || fullPieces(projects.page) || cursor !== null,
        runCursor: cursor ?? null,
    };
};

/**
 * One page of the user's export runs that hold a stored usage object, or are still live, for the erasure's purge. Each run says whether
 * its export is still live: a live run's record stays until its export ends, so its write cannot land after the record is released.
 * A live run with no object yet is listed so the purge waits for it, since its export may still store one.
 * `cursor` is null once the runs are read through.
 */
export const keyedUsageRuns = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), userId: v.string() })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            keyed: v.array(v.object({ key: v.optional(v.string()), live: v.boolean(), runId: v.id("usageExportRuns") })),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const result = await ctx.db.usageExportRuns.findMany({
            consistency: "primary",
            cursor: cursor ?? null,
            limit: EXPORT_PIECE_BATCH,
            where: { userId },
        });
        const keyed = [];

        for (const run of result.page) {
            const live = await isRunLive(ctx, run.requestId, userId);

            // A live run without an object is listed too: its export may still store one, so the purge waits for it to end.
            if (run.usageKey !== undefined || live) {
                keyed.push({ key: run.usageKey, live, runId: run._id });
            }
        }

        return { cursor: result.isDone ? null : result.continueCursor, keyed };
    });

/** Whether an export run is still live: its export request is in flight (`gdpr/export-requests.ts`). */
const isRunLive = async (ctx: MutationCtx | QueryCtx, runKey: string, userId: string): Promise<boolean> => await isExportRequestInFlight(ctx, runKey, userId);

/**
 * Sets a run's due time, and arms its shard for the root tick at that time. The tick reaches a shard by its due time, not by its
 * traffic, so an idle shard's runs are still acted on.
 */
const armRun = async (ctx: MutationCtx, runId: Id<"usageExportRuns">, userId: string, deleteAt: number): Promise<void> => {
    await ctx.db.patch("usageExportRuns", runId, { deleteAt });
    // The run's user's shard, named outright: the sweep's own shard is not always that user's (`currentUserShard()` is undefined off a shard).
    await noteShardDue(ctx, deleteAt, userId);
};

/**
 * How soon the sweep checks a live run the erasure has re-armed (`erasingSince`). A live export can store its object at any moment, so such a
 * run is checked a minute after the last check, and its object goes about a minute after the export ends. Other live runs keep the
 * time to live, so an ended export's object stays downloadable for a day.
 */
export const LIVE_RECHECK_MS = 60 * 1000;

/**
 * How long after the erasure re-armed a run it is checked a minute apart. Past that the run is checked at the time to live again, so a
 * stuck export does not wake its shard every minute for weeks; its object then goes at the first check after the export ends.
 */
export const LIVE_FAST_WINDOW_MS = 60 * 60 * 1000;

/**
 * Hands a live run the erasure could not finish to the sweep: the run is marked `erasingSince` and checked a minute on. The run's record is
 * kept while its export is live, so anything the export stores later is found, and the sweep purges it once the export has ended.
 */
export const rearmLiveUsageRun = internalMutation
    .input({ runId: v.id("usageExportRuns"), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { runId, userId }, ctx }) => {
        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { _id: runId, userId } });

        if (run) {
            await ctx.db.patch("usageExportRuns", run._id, { erasingSince: ctx.now });
            await armRun(ctx, run._id, userId, ctx.now + LIVE_RECHECK_MS);
        }

        return null;
    });

/**
 * Acts on the export runs that are due, one batch per run of the shard's housekeeping (`lib/shard-housekeeping.ts`). A run is due at its
 * `deleteAt`. A run found live is set one time to live ahead (a minute ahead when the erasure re-armed it), so a run that dies at any point
 * before then is found dead at that time:
 * its pieces and index rows go then. A sweep reads at most one batch of pieces in all, however many runs are due, so its reads stay
 * within the transaction's read limit; a run with pieces left is due again at once. A keyed run keeps its row until its purge has
 * released it, and waits a time to live before its next purge.
 */
export const sweepUsageExportPieces = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        // Primary, like every read here that decides a deletion: a stale row could show a run unkeyed after its key was stored.
        const dueAt = (cursor: string | null) =>
            ctx.db.usageExportRuns.findMany({
                consistency: "primary",
                cursor,
                limit: EXPORT_PIECE_BATCH,
                orderBy: [{ deleteAt: "asc" }],
                where: { deleteAt: { lte: ctx.now } },
            });
        let cursor: string | null = null;
        let handled = 0;
        let piecesLeft = EXPORT_PIECE_BATCH;

        // A live run counts toward the batch too, since its re-arm is a census write: a sweep handles at most one batch of runs, so a
        // page of live runs ends the sweep, and the runs behind them are reached by the next sweep.
        while (handled < EXPORT_PIECE_BATCH && piecesLeft > 0) {
            const result = await dueAt(cursor);

            for (const run of result.page) {
                if (handled >= EXPORT_PIECE_BATCH || piecesLeft === 0) {
                    break;
                }

                if (await isRunLive(ctx, run.requestId, run.userId)) {
                    const fast = run.erasingSince !== undefined && ctx.now - run.erasingSince < LIVE_FAST_WINDOW_MS;

                    await armRun(ctx, run._id, run.userId, ctx.now + (fast ? LIVE_RECHECK_MS : EXPORT_PIECE_TTL_MS));
                    // A re-arm is a census write, so it counts toward the batch like a cleared run: one sweep makes at most a batch of them.
                    handled += 1;
                    continue;
                }

                const limit = piecesLeft;
                const pieces = await ctx.db.usageExportPieces.findMany({
                    consistency: "primary",
                    limit,
                    where: { requestId: run.requestId, userId: run.userId },
                });

                await Promise.all(pieces.page.map(async (piece) => await ctx.db.delete("usageExportPieces", piece._id)));

                piecesLeft -= pieces.page.length;

                const projects = await ctx.db.usageExportProjects.findMany({
                    consistency: "primary",
                    limit: EXPORT_PIECE_BATCH,
                    where: { requestId: run.requestId, userId: run.userId },
                });

                await Promise.all(projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)));

                const more = pieces.page.length >= limit || fullPieces(projects.page);

                // Scheduled once the run's pieces and index rows are drained, not on every pass that clears some: a run with pieces
                // left is due again at once, and a purge per pass would queue duplicates while the first one is still running.
                if (run.usageKey !== undefined && !more) {
                    await schedulePurge(ctx, run);
                }

                if (run.usageKey === undefined && !more) {
                    await ctx.db.delete("usageExportRuns", run._id);
                } else {
                    // Pieces remain, so the run is due again at once. A keyed run waits for its purge a time to live from now.
                    await armRun(ctx, run._id, run.userId, more ? ctx.now : ctx.now + EXPORT_PIECE_TTL_MS);
                }

                handled += 1;
            }

            if (result.isDone) {
                break;
            }

            cursor = result.continueCursor;
        }

        return null;
    });

/**
 * Deletes one batch of a run's pieces and index rows, and the run's row once none is left. The caller runs this only after the run's
 * usage object is deleted. `hasMore` while a batch came back full.
 */
export const clearUsageExportPieces = internalMutation
    .input({ requestId: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { requestId, userId }, ctx }) => {
        const { page } = await ctx.db.usageExportPieces.findMany({
            consistency: "primary",
            limit: EXPORT_PIECE_BATCH,
            where: { requestId, userId },
        });

        await Promise.all(page.map(async (piece) => await ctx.db.delete("usageExportPieces", piece._id)));

        const projects = await ctx.db.usageExportProjects.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { requestId, userId } });

        await Promise.all(projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)));

        if (!fullPieces(page) && !fullPieces(projects.page)) {
            const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { requestId, userId } });

            // A run with a stored object keeps its record: it is the object's only record, and the purge releases it.
            if (run && run.usageKey === undefined) {
                await ctx.db.delete("usageExportRuns", run._id);
            }
        }

        return { hasMore: fullPieces(page) || fullPieces(projects.page) };
    });

/**
 * Retention (`gdpr/retention.ts`): one batch of `usageDaily` rows dated before `cutoffDate` (YYYY-MM-DD). Returns how many were deleted.
 */
export const pruneUsageDaysBefore = async (ctx: MutationCtx, cutoffDate: string, limit: number): Promise<number> => {
    const { page: days } = await ctx.db.usageDaily.findMany({
        limit,
        orderBy: [{ date: "asc" }],
        where: { date: { lt: cutoffDate } },
    });

    await Promise.all(days.map(async (row) => await ctx.db.delete("usageDaily", row._id)));

    return days.length;
};
