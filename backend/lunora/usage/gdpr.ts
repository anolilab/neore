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

/** Runs the sweep reads, metadata only, while it looks for dead runs; so live runs cannot fill a whole batch. */
const SWEEP_SCAN_LIMIT = 500;

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
        if (await ctx.storage.getMetadata(key)) {
            await ctx.storage.delete(key);
        }

        await ctx.runMutation(internal.usage.gdpr.releaseUsageKey, { runId });

        return null;
    });

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
 */
export const eraseUsageForUser = async (
    ctx: MutationCtx,
    userId: string,
    runCursor: string | null = null,
): Promise<BatchResult & { runCursor: string | null }> => {
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
    let cursor = runCursor;

    for (let pages = 0; pages < RUN_PAGES_PER_ERASURE; pages += 1) {
        const runs = await runsAt(cursor);

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

        if (cursor === null) {
            break;
        }
    }

    return {
        hasMore: full(days) || full(keys) || full(backfills) || fullPieces(pieces.page) || fullPieces(projects.page) || cursor !== null,
        runCursor: cursor,
    };
};

/**
 * One page of the user's export runs that still hold a stored usage object, for the erasure's purge. Each keyed run says whether its
 * export is still live: a live run's record stays until its export ends, so its write cannot land after the record is released.
 * `cursor` is null once the runs are read through.
 */
export const keyedUsageRuns = internalQuery
    .input({ cursor: v.union(v.string(), v.null()), userId: v.string() })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            keyed: v.array(v.object({ key: v.string(), live: v.boolean(), runId: v.id("usageExportRuns") })),
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
            if (run.usageKey !== undefined) {
                keyed.push({ key: run.usageKey, live: await isRunLive(ctx, run.requestId, userId), runId: run._id });
            }
        }

        return { cursor: result.isDone ? null : result.continueCursor, keyed };
    });

/**
 * Whether an export run is still live: its request is pending or processing. A run's request is the part of its key before the
 * workflow instance. A request that is gone is not live.
 */
const isRunLive = async (ctx: MutationCtx | QueryCtx, runKey: string, userId: string): Promise<boolean> => {
    const request = await ctx.db.gdprRequests.findFirst({
        consistency: "primary",
        where: { _id: runKey.split(":", 1)[0] as Id<"gdprRequests">, userId },
    });

    return request?.status === "pending" || request?.status === "processing";
};

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
 * Acts on the export runs that are due, one batch per run of the shard's housekeeping (`lib/shard-housekeeping.ts`). A run is due at its
 * `deleteAt`. A run found live is set one time to live ahead, so a run that dies at any point before then is found dead at that time:
 * its pieces and index rows go then. A sweep reads at most one batch of pieces in all, however many runs are due, so its reads stay
 * within the transaction's read limit; a run with pieces left is due again at once. A keyed run keeps its row until its purge has
 * released it, and waits a time to live before its next purge.
 */
export const sweepUsageExportPieces = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const dueAt = (cursor: string | null) =>
            ctx.db.usageExportRuns.findMany({
                cursor,
                limit: EXPORT_PIECE_BATCH,
                orderBy: [{ deleteAt: "asc" }],
                where: { deleteAt: { lte: ctx.now } },
            });
        let cursor: string | null = null;
        let handled = 0;
        let scanned = 0;
        let piecesLeft = EXPORT_PIECE_BATCH;

        while (handled < EXPORT_PIECE_BATCH && scanned < SWEEP_SCAN_LIMIT && piecesLeft > 0) {
            const result = await dueAt(cursor);

            scanned += result.page.length;

            for (const run of result.page) {
                if (handled >= EXPORT_PIECE_BATCH || piecesLeft === 0) {
                    break;
                }

                if (await isRunLive(ctx, run.requestId, run.userId)) {
                    await armRun(ctx, run._id, run.userId, ctx.now + EXPORT_PIECE_TTL_MS);
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

                if (run.usageKey !== undefined) {
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

            if (run) {
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
