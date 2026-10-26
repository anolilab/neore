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
/** Streams examined per run. */
export const PURGE_STREAM_BATCH = 25;
/** Chunks deleted per stream per run; a longer stream is finished by the next run. */
export const PURGE_CHUNK_BATCH = 100;

/** Statuses that never change again (`streamStatusValidator` minus the live two). */
const TERMINAL_STATUSES = ["done", "error", "timeout"];

export const purgeFinishedStreams = internalMutation
    .input({})
    .output(v.object({ chunks: v.number(), streams: v.number() }))
    .mutation(async ({ ctx }) => {
        const { page: finished } = await ctx.db.persistentStreams.findMany({
            limit: PURGE_STREAM_BATCH,
            where: { expiresAt: { lt: ctx.now - STREAM_RETENTION_MS }, status: { in: TERMINAL_STATUSES } },
        });
        let chunks = 0;
        let streams = 0;

        for (const stream of finished) {
            const batch = await ctx.db
                .query("persistentChunks")
                .withIndex("by_streamId_seq", (q) => q.eq("streamId", stream._id))
                .take(PURGE_CHUNK_BATCH);

            for (const chunk of batch) {
                await ctx.db.delete(chunk._id);
            }

            chunks += batch.length;

            // A full batch may have left chunks behind: the stream goes once none are left.
            if (batch.length >= PURGE_CHUNK_BATCH) {
                continue;
            }

            await ctx.db.delete(stream._id);
            streams += 1;
        }

        return { chunks, streams };
    });
