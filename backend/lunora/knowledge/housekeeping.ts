/**
 * Background upkeep of knowledge files on one user's shard:
 *
 * - **Draining** files marked {@link DELETING_STATUS} (a collection deleted
 *   with its files). A file may hold thousands of chunks, so a step deletes at
 *   most {@link CHUNKS_PER_DRAIN_STEP} of them and schedules the next step
 *   while any remain — no mutation grows with the size of what is deleted.
 * - **Reaping** ingests that never finished: a file left `pending` or
 *   `processing` past {@link STUCK_INGEST_MS} (its action died, or its job was
 *   lost) is marked `failed`, so the user can retry it instead of watching a
 *   spinner forever.
 *
 * The drain is scheduled by `deleteCollection`; the sweep runs from the shard
 * housekeeping (`lib/shard-housekeeping.ts`) and restarts a drain that stopped.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { deleteKnowledgeFile, deleteKnowledgeFileChunks, DELETING_STATUS } from "./file-removal";

/** Chunks one drain step deletes, across however many files that covers. */
export const CHUNKS_PER_DRAIN_STEP = 500;
/** Files one drain step looks at. */
const FILES_PER_DRAIN_STEP = 20;

/**
 * An ingest runs as one scheduled action, which Cloudflare stops at 15
 * minutes; twice that and it is not coming back.
 */
export const STUCK_INGEST_MS = 30 * 60 * 1000;
/** Files one sweep reaps. */
const REAP_BATCH = 100;

/** Pure: whether an ingest that has not finished should be given up on. */
export const isStuckIngest = (file: { createdAt: number; status: string; updatedAt?: number }, now: number): boolean =>
    (file.status === "pending" || file.status === "processing") && now - (file.updatedAt ?? file.createdAt) > STUCK_INGEST_MS;

/** One bounded drain step. `true` while files marked for deletion remain. */
const drainStep = async (ctx: Pick<MutationCtx, "db" | "scheduler">): Promise<boolean> => {
    const { page: files } = await ctx.db.knowledgeFiles.findMany({ limit: FILES_PER_DRAIN_STEP, where: { status: DELETING_STATUS } });
    let budget = CHUNKS_PER_DRAIN_STEP;

    for (const file of files) {
        if (budget <= 0) {
            return true;
        }

        const { deleted, done } = await deleteKnowledgeFileChunks(ctx, file._id, budget);

        if (!done) {
            return true;
        }

        // A finished file costs at least one unit, so empty files cannot run the step unbounded.
        budget -= Math.max(1, deleted);
        await deleteKnowledgeFile(ctx, file);
    }

    return (await ctx.db.knowledgeFiles.findFirst({ where: { status: DELETING_STATUS } })) !== null;
};

/** Removes marked files a batch at a time, rescheduling itself until none are left. */
export const drainDeletingFiles = internalMutation
    .input({})
    .output(v.object({ more: v.boolean() }))
    .mutation(async ({ ctx }) => {
        const more = await drainStep(ctx);

        if (more) {
            await ctx.scheduler.runAfter(0, internal.knowledge.housekeeping.drainDeletingFiles, {});
        }

        return { more };
    });

/** Housekeeping sweep: fail stuck ingests, and restart a drain that stopped. */
export const sweepKnowledgeFiles = internalMutation
    .input({})
    .output(v.object({ draining: v.boolean(), reaped: v.number() }))
    .mutation(async ({ ctx }) => {
        const now = ctx.now;
        const { page: unfinished } = await ctx.db.knowledgeFiles.findMany({
            limit: REAP_BATCH,
            where: { status: { in: ["pending", "processing"] } },
        });
        const stuck = unfinished.filter((file) => isStuckIngest(file, now));

        await Promise.all(
            stuck.map(
                async (file) =>
                    await ctx.db.patch(file._id, { error: "Indexing did not finish. Remove the file and add it again.", status: "failed", updatedAt: now }),
            ),
        );

        const draining = (await ctx.db.knowledgeFiles.findFirst({ where: { status: DELETING_STATUS } })) !== null;

        if (draining) {
            await ctx.scheduler.runAfter(0, internal.knowledge.housekeeping.drainDeletingFiles, {});
        }

        return { draining, reaped: stuck.length };
    });
