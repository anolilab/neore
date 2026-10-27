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
/** Pages read per run, so a stream behind a page of big ones is still reached. */
export const PURGE_SCAN_PAGES = 4;
/** Chunks deleted per stream per run; a longer stream is finished by a later run. */
export const PURGE_CHUNK_BATCH = 100;
/**
 * Streams with more chunks than one batch that are worked on per run. The rest
 * wait, so a page full of big streams cannot use up the run and starve the small
 * expired streams queued behind them.
 */
export const PURGE_LARGE_STREAMS_PER_RUN = 5;

/** Statuses that never change again (`streamStatusValidator` minus the live two). */
const TERMINAL_STATUSES = ["done", "error", "timeout"];

export const purgeFinishedStreams = internalMutation
    .input({})
    .output(v.object({ chunks: v.number(), streams: v.number() }))
    .mutation(async ({ ctx }) => {
        let chunks = 0;
        let streams = 0;
        let largeLeft = PURGE_LARGE_STREAMS_PER_RUN;
        let cursor: string | undefined;

        for (let pageNumber = 0; pageNumber < PURGE_SCAN_PAGES; pageNumber += 1) {
            const page = await ctx.db.persistentStreams.findMany({
                cursor,
                limit: PURGE_STREAM_BATCH,
                where: { expiresAt: { lt: ctx.now - STREAM_RETENTION_MS }, status: { in: TERMINAL_STATUSES } },
            });

            for (const stream of page.page) {
                const batch = await ctx.db
                    .query("persistentChunks")
                    .withIndex("by_streamId_seq", (q) => q.eq("streamId", stream._id))
                    .take(PURGE_CHUNK_BATCH);
                // A full batch may have left chunks behind: the stream goes once none are left.
                const complete = batch.length < PURGE_CHUNK_BATCH;

                if (!complete) {
                    if (largeLeft === 0) {
                        continue;
                    }

                    largeLeft -= 1;
                }

                for (const chunk of batch) {
                    await ctx.db.delete(chunk._id);
                }

                chunks += batch.length;

                if (complete) {
                    await ctx.db.delete(stream._id);
                    streams += 1;
                }
            }

            if (page.isDone || !page.continueCursor) {
                break;
            }

            cursor = page.continueCursor;
        }

        return { chunks, streams };
    });
