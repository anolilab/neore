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
    .input({ key: v.string().max(MAX_LENGTH.id), runId: v.id("usageExportRuns") })
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
export const eraseUsageForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [days, keys, backfills, pieces, projects, runs] = await Promise.all([
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
        ctx.db.usageExportRuns.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { userId } }),
    ]);

    await Promise.all([
        ...days.map(async (row) => await ctx.db.delete("usageDaily", row._id)),
        ...keys.map(async (row) => await ctx.db.delete("usageReplies", row._id)),
        ...backfills.map(async (row) => await ctx.db.delete("usageBackfill", row._id)),
        ...pieces.page.map(async (row) => await ctx.db.delete("usageExportPieces", row._id)),
        ...projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)),
    ]);

    // A run with an object keeps its row: the erasure's purge step deletes the object, then releases the row, so the erasure is not
    // done while an object remains. A run without one has nothing left to keep.
    let unkeyed = 0;

    for (const run of runs.page) {
        if (run.usageKey !== undefined) {
            continue;
        }

        unkeyed += 1;
        await ctx.db.delete("usageExportRuns", run._id);
    }

    return {
        hasMore: full(days) || full(keys) || full(backfills) || fullPieces(pieces.page) || fullPieces(projects.page) || (fullPieces(runs.page) && unkeyed > 0),
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
 * Whether the account's deletion has begun, read from the primary: a replica that has not seen the deletion would let a write through
 * after the erasure has passed over the rollup. Only the blocking statuses count: a failed or cancelled deletion holds nothing back.
 */
export const deletionUnderwayOnPrimary = async (ctx: MutationCtx | QueryCtx, userId: string): Promise<boolean> => {
    const request = await ctx.db.gdprRequests.findFirst({
        consistency: "primary",
        where: { requestType: "deletion", status: { in: ["completed", "pending", "processing"] }, userId },
    });

    return Boolean(request);
};

/**
 * Whether an export run is still live: its request is pending or processing. A run's request is the part of its key before the
 * workflow instance. A request that is gone is not live.
 */
const isRunLive = async (ctx: MutationCtx | QueryCtx, runKey: string, userId: string): Promise<boolean> => {
    const request = await ctx.db.gdprRequests.findFirst({ where: { _id: runKey.split(":", 1)[0] as Id<"gdprRequests">, userId } });

    return request?.status === "pending" || request?.status === "processing";
};

/**
 * Removes the runs that are no longer live, their pieces and index rows, one batch per run of the shard's housekeeping
 * (`lib/shard-housekeeping.ts`). The scan reads run rows only: their metadata, not the pieces' payloads. A run is a candidate once its
 * row is older than {@link EXPORT_PIECE_TTL_MS}. A live run moves to the newest end of the scan, so the expired runs behind it are
 * reached by the next sweep. For a dead run the sweep reads its pieces a batch at a time and schedules its purge; the run's row stays
 * until the purge has released it.
 */
export const sweepUsageExportPieces = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const cutoff = ctx.now - EXPORT_PIECE_TTL_MS;
        const runsAt = (cursor: string | null) =>
            ctx.db.usageExportRuns.findMany({
                cursor,
                limit: EXPORT_PIECE_BATCH,
                orderBy: [{ createdAt: "asc" }],
                where: { createdAt: { lt: cutoff } },
            });
        let cursor: string | null = null;
        let handled = 0;
        let scanned = 0;

        while (handled < EXPORT_PIECE_BATCH && scanned < SWEEP_SCAN_LIMIT) {
            const result = await runsAt(cursor);

            scanned += result.page.length;

            for (const run of result.page) {
                if (handled >= EXPORT_PIECE_BATCH) {
                    break;
                }

                // A live run moves to the newest end of the scan, so the expired runs behind it are reached by the next sweep.
                if (await isRunLive(ctx, run.requestId, run.userId)) {
                    await ctx.db.patch("usageExportRuns", run._id, { createdAt: ctx.now });
                    continue;
                }

                // A dead run's pieces are read here, and only here: one batch at a time.
                const pieces = await ctx.db.usageExportPieces.findMany({
                    consistency: "primary",
                    limit: EXPORT_PIECE_BATCH,
                    where: { requestId: run.requestId, userId: run.userId },
                });

                await Promise.all(pieces.page.map(async (piece) => await ctx.db.delete("usageExportPieces", piece._id)));

                const projects = await ctx.db.usageExportProjects.findMany({
                    consistency: "primary",
                    limit: EXPORT_PIECE_BATCH,
                    where: { requestId: run.requestId, userId: run.userId },
                });

                await Promise.all(projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)));
                await schedulePurge(ctx, run);

                if (!fullPieces(pieces.page) && !fullPieces(projects.page) && run.usageKey === undefined) {
                    await ctx.db.delete("usageExportRuns", run._id);
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
    .input({ requestId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
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
