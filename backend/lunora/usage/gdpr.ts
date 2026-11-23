/**
 * Erasure, cleanup and retention of the usage tables: `usageDaily`, `usageReplies`, `usageBackfill`, and the export's pieces
 * (`usageExportPieces`), project index (`usageExportProjects`) and runs (`usageExportRuns`), owned by the usage module.
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's transaction. Typed ids only: an `Id<TableName>` would
 * read as a write to every table. A failed delete throws, so its erasure step fails, and the retry finishes what is left.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { browserExportPrefix } from "../browser/export-pages";
import { BATCH, full, type BatchResult } from "../gdpr/batch";
import { isExportRequestInFlight } from "../gdpr/export-requests";
import { patchRow } from "../lib/patch";
import { noteShardDue } from "../lib/shard-housekeeping";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { addDays, exportedUsageRow, RECORD_RETRY } from "./activity-logic";
import { type ClosedTotals, USAGE_COUNT_PAGE, USAGE_EXPORT_PAGE } from "./export-limits";

export {
    type ClosedTotals,
    PROJECT_POSITION,
    TITLE_ID_BYTES,
    TITLE_PIECE_BYTES,
    TITLE_STEP_BYTES,
    USAGE_COUNT_PAGE,
    USAGE_EXPORT_ATTEMPTS,
    USAGE_EXPORT_BYTES,
    USAGE_EXPORT_PAGE,
    USAGE_EXPORT_PASSES,
    USAGE_TITLE_STEP,
} from "./export-limits";

/** Pieces one read of an export's pieces returns. */
const PIECES_PER_READ = 20;

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

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

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

/** Releases a run's record once its object is gone ({@link releaseRun}). */
export const releaseUsageKey = internalMutation
    .input({ runId: v.id("usageExportRuns") })
    .output(v.null())
    .mutation(async ({ args: { runId }, ctx }) => {
        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { _id: runId } });

        if (run) {
            await releaseRun(ctx, run);
        }

        return null;
    });

/**
 * Clears a run's key and removes its row once no piece and no index row of the run is left; a run still holding either keeps its row,
 * so the sweep can finish them.
 */
const releaseRun = async (ctx: MutationCtx, run: { _id: Id<"usageExportRuns">; requestId: string; usageKey?: string; userId: string }): Promise<void> => {
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
};

/**
 * Called once the sweep's deletion of a dead run's browser pages has succeeded (`browser/gdpr.ts#deleteBrowserExportPages`). Only then
 * does the run's record go: a keyed run's purge is scheduled, and releases the record after its object; an unkeyed run is released now.
 * A deletion that fails for good never calls this, so the record stays and a later sweep deletes the pages again.
 */
export const releaseBrowserPages = internalMutation
    .input({ runId: v.id("usageExportRuns") })
    .output(v.null())
    .mutation(async ({ args: { runId }, ctx }) => {
        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { _id: runId } });

        if (!run) {
            return null;
        }

        await (run.usageKey === undefined ? releaseRun(ctx, run) : schedulePurge(ctx, run));

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
    // The organizations' lists of who has rows under them (`usageOrganizationContributors`, a global table, read through its own API).
    // From the primary: a replica that lags a committed entry would end the erasure with the user's ID still in a list, and a stale
    // one would return rows an earlier batch deleted.
    const { page: contributors } = await ctx.db.usageOrganizationContributors.findMany({ consistency: "primary", limit: BATCH, where: { userId } });
    const [days, keys, backfills, ledger, pieces, projects] = await Promise.all([
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
        // The organization ledger (`usageOrganizationReplies`): a member's replies filed under their organizations' projects.
        // From the primary: a replica that lags committed rows would let erasure report done with them left on the shard.
        ctx.db.usageOrganizationReplies.findMany({ consistency: "primary", limit: BATCH, where: { userId } }).then((result) => result.page),
        ctx.db.usageExportPieces.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { userId } }),
        ctx.db.usageExportProjects.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { userId } }),
    ]);

    await Promise.all([
        ...days.map(async (row) => await ctx.db.delete("usageDaily", row._id)),
        ...keys.map(async (row) => await ctx.db.delete("usageReplies", row._id)),
        ...backfills.map(async (row) => await ctx.db.delete("usageBackfill", row._id)),
        ...ledger.map(async (row) => await ctx.db.delete("usageOrganizationReplies", row._id)),
        ...contributors.map(async (row) => await ctx.db.delete("usageOrganizationContributors", row._id)),
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
        hasMore:
            full(days) ||
            full(keys) ||
            full(backfills) ||
            full(ledger) ||
            full(contributors) ||
            fullPieces(pieces.page) ||
            fullPieces(projects.page) ||
            cursor !== null,
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
 * within the transaction's read limit; a run with pieces left is due again at once. A drained run keeps its row until its browser pages
 * are deleted and, if keyed, its purge has released it, and waits a time to live before the sweep tries its cleanup again.
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

                // A dead run's browser pages, which the export stores under a prefix derived from the run (`browser/export-pages.ts`).
                // Scheduled once the run's pieces and index rows are drained, not on every pass that clears some: a run with pieces left
                // is due again at once, and a deletion per pass would queue duplicates. The record stays until the deletion succeeds
                // (`releaseBrowserPages`, which then schedules a keyed run's purge), so a deletion that exhausts its retries is tried
                // again by the sweep a time to live from now.
                if (!more) {
                    await runAfterOnShard(
                        ctx.scheduler,
                        0,
                        internal.browser.gdpr.deleteBrowserExportPages,
                        { prefix: browserExportPrefix(run.userId, run.requestId), runId: run._id },
                        run.userId,
                        RECORD_RETRY,
                    );
                }

                // Pieces remain, so the run is due again at once; otherwise a time to live from now, in case its cleanup fails for good.
                await armRun(ctx, run._id, run.userId, more ? ctx.now : ctx.now + EXPORT_PIECE_TTL_MS);

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
 * usage object is deleted. `hasMore` while a batch came back full. `keepRun` keeps the record all the same: a discarded pass's run goes
 * on, and its browser pages are found by the sweep through that record.
 */
export const clearUsageExportPieces = internalMutation
    .input({ keepRun: v.optional(v.boolean()), requestId: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { keepRun, requestId, userId }, ctx }) => {
        const { page } = await ctx.db.usageExportPieces.findMany({
            consistency: "primary",
            limit: EXPORT_PIECE_BATCH,
            where: { requestId, userId },
        });

        await Promise.all(page.map(async (piece) => await ctx.db.delete("usageExportPieces", piece._id)));

        const projects = await ctx.db.usageExportProjects.findMany({ consistency: "primary", limit: EXPORT_PIECE_BATCH, where: { requestId, userId } });

        await Promise.all(projects.page.map(async (row) => await ctx.db.delete("usageExportProjects", row._id)));

        if (keepRun !== true && !fullPieces(page) && !fullPieces(projects.page)) {
            const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { requestId, userId } });

            // A run with a stored object keeps its record: it is the object's only record, and the purge releases it.
            if (run && run.usageKey === undefined) {
                await ctx.db.delete("usageExportRuns", run._id);
            }
        }

        return { hasMore: fullPieces(page) || fullPieces(projects.page) };
    });

/**
 * Clears one pass's verified title pieces, a batch per call, before the ownership re-check writes them again. The rows pieces and the
 * run stay: only the titles are re-verified.
 */
export const clearVerifiedUsagePieces = internalMutation
    .input({ pass: v.number(), requestId: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { pass, requestId, userId }, ctx }) => {
        const { page } = await ctx.db.usageExportPieces.findMany({
            consistency: "primary",
            limit: EXPORT_PIECE_BATCH,
            where: { kind: "verified", pass, requestId, userId },
        });

        await Promise.all(page.map(async (piece) => await ctx.db.delete("usageExportPieces", piece._id)));

        return { hasMore: fullPieces(page) };
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

/**
 * The organizations one prune batch takes rows from. Each organization a batch empties books a reconcile on the scheduler, a subrequest, so a
 * batch over a member's many organizations stays under the Free Worker's 50; the rest are taken by the next batch.
 */
export const MAX_PRUNED_ORGANIZATIONS = 20;

/**
 * Retention (`gdpr/retention.ts`): one batch of `usageOrganizationReplies` rows recorded before `cutoff` (epoch ms). Returns how many rows
 * were deleted. The contributor entries of the members they belonged to are settled after this write commits
 * (`reconcileOrganizationContributor`), not here: a member left with no rows loses their entry, and one with rows keeps it.
 */
export const pruneOrganizationRepliesBefore = async (ctx: MutationCtx, cutoff: number, limit: number): Promise<number> => {
    const { page } = await ctx.db.usageOrganizationReplies.findMany({
        limit,
        orderBy: [{ at: "asc" }],
        where: { at: { lt: cutoff } },
    });

    // Oldest first, up to the batch's organization bound; a row of an organization past it waits for the next batch.
    const members = new Map<string, (typeof page)[number]>();
    const taken: typeof page = [];

    for (const row of page) {
        const key = `${row.organizationId}\u{0}${row.userId}`;

        if (!members.has(key)) {
            if (members.size >= MAX_PRUNED_ORGANIZATIONS) {
                continue;
            }

            members.set(key, row);
        }

        taken.push(row);
    }

    await Promise.all(taken.map(async (row) => await ctx.db.delete("usageOrganizationReplies", row._id)));

    for (const row of members.values()) {
        // A member with rows left keeps their entry, so only an organization this batch emptied needs the reconcile.
        const left = await ctx.db.usageOrganizationReplies.findFirst({
            consistency: "primary",
            where: { organizationId: row.organizationId, userId: row.userId },
        });

        if (left) {
            continue;
        }

        await runAfterOnShard(
            ctx.scheduler,
            0,
            internal.usage.organization.reconcileOrganizationContributor,
            { organizationId: row.organizationId, userId: row.userId },
            row.userId,
            RECORD_RETRY,
        );
    }

    return taken.length;
};

/**
 * The run's row, created with its first piece. A run's row is what the sweep reads to find it, so a run has one from its first page.
 */
const ensureRun = async (ctx: MutationCtx, requestId: string, userId: string): Promise<void> => {
    const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { requestId, userId } });

    if (!run) {
        const deleteAt = ctx.now + EXPORT_PIECE_TTL_MS;

        await ctx.db.insert("usageExportRuns", { createdAt: ctx.now, deleteAt, requestId, userId });
        await noteShardDue(ctx, deleteAt, userId);
    }
};

/**
 * The run's record, written before the export stores anything else of its own (its browser pages), so a run killed before its
 * cleanup is found by the sweep. Refused once the account's deletion has begun, as every write of the run is.
 */
export const openUsageExportRun = internalMutation
    .input({ requestId: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { requestId, userId }, ctx }) => {
        if (await deletionUnderwayOnPrimary(ctx, userId)) {
            throw new LunoraError("CONFLICT", "Account deletion is underway; the export stops");
        }

        await ensureRun(ctx, requestId, userId);

        return null;
    });

const pageSummary = v.object({
    backfill: v.string(),
    bytes: v.number(),
    closed: v.object({ cost: v.number(), replies: v.number(), rows: v.number(), tokens: v.number() }),
    cutoff: v.string(),
    nextCursor: v.union(v.string(), v.null()),
    projectIds: v.array(v.string()),
    rowCount: v.number(),
});

const cursorArgument = v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null()));

/**
 * The day the recount's closed region ends: two days before the latest usage date the user has, read from the rows and not the
 * clock, so a replay of the first page computes the same day. A user west of UTC, whose live rows are dated a day behind the
 * UTC date, and a late retry of a reply from two days back both fall on or after it. No rows give an empty cutoff, which
 * closes nothing.
 */
const cutoffFromRows = async (ctx: MutationCtx, userId: string): Promise<string> => {
    const { page } = await ctx.db.usageDaily.findMany({ consistency: "primary", limit: 1, orderBy: [{ date: "desc" }], where: { userId } });

    return page[0] ? addDays(page[0].date, -2) : "";
};

/**
 * Whether the account's deletion has begun, read from the primary: a replica that has not seen the deletion would let a write
 * through after the erasure has passed over the rollup.
 */
export const deletionUnderwayOnPrimary = async (ctx: MutationCtx | QueryCtx, userId: string): Promise<boolean> => {
    // A failed deletion blocks too: its erasure may already have passed the rollup, and its retry does not erase again. Only a
    // cancelled one does not hold the export back.
    const request = await ctx.db.gdprRequests.findFirst({
        consistency: "primary",
        where: { requestType: "deletion", status: { in: ["completed", "failed", "pending", "processing"] }, userId },
    });

    return Boolean(request);
};

/**
 * Whether an export run may no longer store anything: the account's deletion has begun ({@link deletionUnderwayOnPrimary}), or the run's
 * request is no longer in flight (cancelled, failed, done or gone), which is how the sweep finds the run dead and deletes its pages. Checked
 * before and after each browser page the run stores, so a page written as the sweep released the run is deleted by its writer.
 */
export const exportRunStopped = internalQuery
    .input({ runKey: v.string().max(MAX_LENGTH.key), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args: { runKey, userId }, ctx }) => (await deletionUnderwayOnPrimary(ctx, userId)) || !(await isRunLive(ctx, runKey, userId)));

/** The user's backfill row as the export compares it: a change to any of these during the export is history written meanwhile. */
const backfillFingerprint = async (ctx: MutationCtx | QueryCtx, userId: string): Promise<string> => {
    const row = await ctx.db.usageBackfill.findFirst({ consistency: "primary", where: { userId } });

    return row ? JSON.stringify([row.finishedAt ?? null, row.replies, row.runId, row.startedAt, row.status]) : "";
};

/**
 * One page of the user's rollup, exported and persisted as piece `seq` of `pass` for the export run `requestId`. The first page
 * of a run sets the cutoff (from the rows, see {@link cutoffFromRows}) and the run keeps it. A retry of the step finds its piece
 * and returns the same summary, so the page is never written twice. Nothing is written once the account's deletion has begun.
 */
export const persistUsageRowsPage = internalMutation
    .input({
        cursor: cursorArgument,
        cutoff: v.optional(v.string().max(10)),
        pass: v.number(),
        requestId: v.string().max(MAX_LENGTH.id),
        seq: v.number(),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(pageSummary)
    .mutation(async ({ args: { cursor, cutoff, pass, requestId, seq, userId }, ctx }) => {
        // From the primary: a retry whose first write is not yet on a replica must find it, or the page is written twice.
        const kept = await ctx.db.usageExportPieces.findFirst({ consistency: "primary", where: { kind: "rows", pass, requestId, seq, userId } });

        if (kept) {
            if (kept.closed === undefined) {
                // Every rows piece is written with its totals, so a piece without them is not one this code wrote.
                throw new Error("An export piece has no totals; the export is restarted");
            }

            return {
                backfill: kept.backfill ?? "",
                bytes: kept.bytes,
                closed: kept.closed,
                cutoff: kept.cutoff ?? "",
                nextCursor: kept.nextCursor ?? null,
                projectIds: kept.projectIds,
                rowCount: kept.rowCount,
            };
        }

        // Stored under a deletion, the pieces would outlive the erasure pass that is already draining the rollup.
        if (await deletionUnderwayOnPrimary(ctx, userId)) {
            throw new LunoraError("CONFLICT", "Account deletion is underway; the usage export stops");
        }

        await ensureRun(ctx, requestId, userId);

        const day = cutoff ?? (await cutoffFromRows(ctx, userId));
        const backfill = await backfillFingerprint(ctx, userId);
        const result = await ctx.db.usageDaily.findMany({
            consistency: "primary",
            cursor: cursor ?? null,
            limit: USAGE_EXPORT_PAGE,
            orderBy: [{ date: "asc" }],
            where: { userId },
        });
        const payload = JSON.stringify(result.page.map((row) => exportedUsageRow(row)));
        const projectIds = [...new Set(result.page.flatMap((row) => (row.projectKey === undefined ? [] : [row.projectKey])))];
        const closed = closedTotalsOf(result.page, day);
        const nextCursor = result.isDone ? null : result.continueCursor;
        const bytes = utf8Bytes(payload);

        await ctx.db.insert("usageExportPieces", {
            backfill,
            bytes,
            closed,
            closedRows: closed.rows,
            createdAt: ctx.now,
            cutoff: day,
            kind: "rows",
            pass,
            payload,
            projectIds,
            requestId,
            rowCount: result.page.length,
            seq,
            userId,
            ...(nextCursor !== null && { nextCursor }),
        });

        // The page's projects, as their own piece: a title step reads these ids and never the rows.
        // A project an earlier page of this pass named is not named again: each project is read once per pass.
        const fresh: string[] = [];

        for (const projectId of projectIds) {
            const seen = await ctx.db.usageExportProjects.findFirst({ consistency: "primary", where: { pass, projectId, requestId, userId } });

            if (!seen) {
                await ctx.db.insert("usageExportProjects", { pass, projectId, requestId, userId });
                fresh.push(projectId);
            }
        }

        const projectPayload = JSON.stringify(fresh);

        await ctx.db.insert("usageExportPieces", {
            bytes: utf8Bytes(projectPayload),
            createdAt: ctx.now,
            kind: "projects",
            pass,
            payload: projectPayload,
            projectIds: [],
            requestId,
            rowCount: fresh.length,
            seq,
            userId,
        });

        return { backfill, bytes, closed, cutoff: day, nextCursor, projectIds, rowCount: result.page.length };
    });

/** The totals of the rows dated before `cutoff` (YYYY-MM-DD) among `rows`. */
export const closedTotalsOf = (
    rows: ReadonlyArray<{ costMicrodollars: number; date: string; replies: number; tokens: number }>,
    cutoff: string,
): ClosedTotals => {
    const totals: ClosedTotals = { cost: 0, replies: 0, rows: 0, tokens: 0 };

    for (const row of rows) {
        if (row.date >= cutoff) {
            continue;
        }

        totals.cost += row.costMicrodollars;
        totals.replies += row.replies;
        totals.rows += 1;
        totals.tokens += row.tokens;
    }

    return totals;
};

/** One recount page: the totals of the rows dated before `cutoff` it holds, and the backfill row as it stands. Nothing is kept. */
export const countUsageRowsPage = internalQuery
    .input({ cursor: cursorArgument, cutoff: v.string().max(10), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            backfill: v.string(),
            closed: v.object({ cost: v.number(), replies: v.number(), rows: v.number(), tokens: v.number() }),
            cursor: v.union(v.string(), v.null()),
        }),
    )
    .query(async ({ args: { cursor, cutoff, userId }, ctx }) => {
        // From the primary: a replica that has not seen a backfill's row would pass the recount it should fail.
        const result = await ctx.db.usageDaily.findMany({
            consistency: "primary",
            cursor: cursor ?? null,
            limit: USAGE_COUNT_PAGE,
            orderBy: [{ date: "asc" }],
            where: { date: { lt: cutoff }, userId },
        });

        return {
            backfill: await backfillFingerprint(ctx, userId),
            closed: closedTotalsOf(result.page, cutoff),
            cursor: result.isDone ? null : result.continueCursor,
        };
    });

/**
 * The projects of `ids` the user still owns, read from the primary, with the bytes of the documents read: the usage action's
 * re-check, made just before the file is written.
 */
/** The payloads of one kind of a run's pieces for `pass`, in `seq` order, a few at a time, from the primary. */
export const readUsageExportPieces = internalQuery
    .input({
        cursor: cursorArgument,
        kind: v.union(v.literal("rows"), v.literal("verified")),
        pass: v.number(),
        requestId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ cursor: v.union(v.string(), v.null()), payloads: v.array(v.string()) }))
    .query(async ({ args: { cursor, kind, pass, requestId, userId }, ctx }) => {
        const result = await ctx.db.usageExportPieces.findMany({
            consistency: "primary",
            cursor: cursor ?? null,
            limit: PIECES_PER_READ,
            orderBy: [{ seq: "asc" }],
            where: { kind, pass, requestId, userId },
        });

        return { cursor: result.isDone ? null : result.continueCursor, payloads: result.page.map((piece) => piece.payload) };
    });

/**
 * Records the key of the usage JSON object a run stores, before the object is written: the run's row names it, so a run that dies
 * after this leaves a record the sweep can act on, and the object never outlives its run.
 */
export const recordUsageFile = internalMutation
    .input({ key: v.string().max(MAX_LENGTH.id), requestId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { key, requestId, userId }, ctx }) => {
        // Checked in the same write that names the object: a record written after erasure would outlive its purge.
        if (await deletionUnderwayOnPrimary(ctx, userId)) {
            throw new LunoraError("CONFLICT", "Account deletion is underway; the usage export stops");
        }

        await ensureRun(ctx, requestId, userId);

        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { requestId, userId } });

        if (run) {
            await ctx.db.patch("usageExportRuns", run._id, { usageKey: key });
        }

        return null;
    });

/**
 * Names a stored usage object again, in a run row of its own, after its record was released: the row is due at once, so the sweep purges
 * the object if its removal does not finish here. Returns the row, which the caller releases once the object is gone.
 */
export const keepUsageFileRecord = internalMutation
    .input({ key: v.string().max(MAX_LENGTH.id), requestId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.id("usageExportRuns"))
    .mutation(async ({ args: { key, requestId, userId }, ctx }) => {
        const runId = await ctx.db.insert("usageExportRuns", { createdAt: ctx.now, deleteAt: ctx.now, requestId, usageKey: key, userId });

        await noteShardDue(ctx, ctx.now, userId);

        return runId;
    });

/**
 * Confirms, after the usage object was written, that its run still names it and that no deletion has begun. `false` means the
 * object must be removed: its record was released with the erasure, or the account is being deleted.
 */
export const confirmUsageFile = internalQuery
    .input({ key: v.string().max(MAX_LENGTH.id), requestId: v.string().max(MAX_LENGTH.id), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .query(async ({ args: { key, requestId, userId }, ctx }) => {
        if (await deletionUnderwayOnPrimary(ctx, userId)) {
            return false;
        }

        const run = await ctx.db.usageExportRuns.findFirst({ consistency: "primary", where: { requestId, userId } });

        return run?.usageKey === key;
    });
