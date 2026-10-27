/**
 * Retention for `persistentStreams` / `persistentChunks`. The expiry sweep
 * (`crons.ts`) turns a stale stream into `timeout` but nothing deleted a stream
 * once it finished, so both tables grew for the life of the account.
 *
 * A finished stream's chunks are read by nobody once the reply row is saved:
 * the live placeholder (`getActiveStreamForThread`) only looks at `pending` /
 * `streaming` rows, the share view reads message rows, and a poll
 * (`getChunksAfter`) answers `error` for a missing stream. The longest reader of
 * a settled stream is an approval answered late: `toolApprovalRuns.streamId`
 * points a repeated answer at the resumed stream for as long as the approval
 * lives, so the window is never shorter than that (`PENDING_APPROVAL_TTL_MS`).
 *
 * Runs from the per-shard housekeeping sweep (`lib/shard-housekeeping.ts`).
 * Neither table is audited, so deleting in a batch is safe.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../../../_generated/server";
import { PENDING_APPROVAL_TTL_MS } from "../../lib/tool-approval-cleanup";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long past `expiresAt` a finished stream is kept. */
export const STREAM_RETENTION_MS = Math.max(7 * DAY_MS, PENDING_APPROVAL_TTL_MS);
/** Streams read per page. */
export const PURGE_STREAM_BATCH = 25;
/**
 * Deletes (chunk rows and stream rows, one op each) per run, spread over however
 * many streams that takes. Every run spends this many while any work remains,
 * whatever the size or order of the streams, so a drained stream never blocks the
 * ones behind it and a run's writes stay bounded. An idle shard is swept daily
 * for 30 days (`HOUSEKEEPING_HORIZON_MS`), and a stream is first eligible 7 days
 * after it expires, so about 23 daily runs remain for a given stream.
 *
 * - Large streams: M chunks clear in ceil((M + streams) / 2500) runs, so 23 runs
 *   clear about 57,000 ops.
 * - Small streams: a 2-chunk stream costs 3 ops, so one run clears 833 of them
 *   (not the 100 a four-page scan allowed), and 2,500 of them take 3 runs.
 */
export const PURGE_OP_BUDGET = 2500;

/** Statuses that never change again (`streamStatusValidator` minus the live two). */
const TERMINAL_STATUSES = ["done", "error", "timeout"];

export const purgeFinishedStreams = internalMutation
    // `budget` exists so tests can prove the paging with small numbers; the sweep passes none.
    .input({ budget: v.optional(v.number().int().min(1)) })
    .output(v.object({ chunks: v.number(), streams: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const budget = args.budget ?? PURGE_OP_BUDGET;
        let chunks = 0;
        let streams = 0;
        let cursor: string | undefined;

        do {
            const page = await ctx.db.persistentStreams.findMany({
                cursor,
                limit: PURGE_STREAM_BATCH,
                where: { expiresAt: { lt: ctx.now - STREAM_RETENTION_MS }, status: { in: TERMINAL_STATUSES } },
            });

            for (const stream of page.page) {
                // The stream row costs one op of its own, so it is only deleted when it fits.
                const remaining = budget - chunks - streams;

                if (remaining <= 0) {
                    return { chunks, streams };
                }

                const batch = await ctx.db
                    .query("persistentChunks")
                    .withIndex("by_streamId_seq", (q) => q.eq("streamId", stream._id))
                    .take(remaining);
                const drained = batch.length < remaining;

                for (const chunk of batch) {
                    await ctx.db.delete(chunk._id);
                    chunks += 1;
                }

                // The stream goes once none of its chunks are left; otherwise it resumes next run.
                if (drained) {
                    await ctx.db.delete(stream._id);
                    streams += 1;
                }
            }

            cursor = page.isDone ? undefined : (page.continueCursor ?? undefined);
        } while (cursor);

        return { chunks, streams };
    });
