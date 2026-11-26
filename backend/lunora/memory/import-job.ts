/**
 * The background import of a large memory file (`importMemoryFile`, `./import.ts`). The action parses the file at the
 * boundary and stores its parsed, redacted entries, never the raw file, as `memoryImportBatches` rows. One queue message
 * per batch then runs the paste's labelling check and `importFacts` (`runMemoryImportBatch`), so a batch costs what an
 * inline file costs.
 *
 * Every batch is claimed in a mutation before any work: only the batch named by the job's `nextBatch` that no delivery
 * has claimed yet. A redelivery finds the claim taken and does nothing; a delivery that died mid-batch is ended by
 * {@link reapMemoryImportJob}, scheduled past the longest a batch may take, which fails the job (the entries already
 * written stay). Completion, failure, cancellation and the reaper each act only on the job's current batch, so a late
 * batch never revives or double-counts a job that ended. Whatever ends a job deletes its stored entries.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { JOB_DISPATCH_TIMEOUT_MS } from "../lib/job-queue-config";
import { enqueueJob } from "../lib/job-queue";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { readMemoryEnabled } from "./functions";
import { importFacts, keepLabelledEntries } from "./import";
import { IMPORT_MEMORY_OFF_MESSAGE } from "./import-logic";
import { vMemoryType } from "./taxonomy";

/** Past the longest a batch may take (the queue's dispatch timeout, and the retry that follows a failed one). */
export const STALE_IMPORT_BATCH_MS = JOB_DISPATCH_TIMEOUT_MS + 6 * 60_000;

/** Reaper `batch` value for a job that has not started: its entries are still being stored. */
const PREPARING = -1;

/** Jobs kept per user once a new one is prepared: the latest few, so the progress read has something to show. */
const JOBS_KEPT = 5;

export const IMPORT_RUNNING_MESSAGE = "A memory import is already running. Wait for it to finish, or cancel it.";
const CANCELLED_MESSAGE = "The import was cancelled. Memories already imported are kept.";
const STALLED_MESSAGE = "The import stopped before it finished. Memories already imported are kept.";
const FAILED_MESSAGE = "The import stopped because a step failed. Memories already imported are kept.";

const vEntry = v.object({ memory: v.string(), type: vMemoryType });

const ACTIVE = new Set<Doc<"memoryImportJobs">["status"]>(["preparing", "queued", "running"]);

/** Deletes every stored batch of the job (at most 5000 entries: 200 batches). */
const dropBatches = async (ctx: MutationCtx, jobId: Id<"memoryImportJobs">): Promise<void> => {
    const rows = await ctx.db
        .query("memoryImportBatches")
        .withIndex("by_jobId_index", (q) => q.eq("jobId", jobId))
        .take(250);

    for (const row of rows) {
        await ctx.db.delete("memoryImportBatches", row._id);
    }
};

/** Ends an active job as failed and deletes its stored entries. */
const failJob = async (ctx: MutationCtx, job: Doc<"memoryImportJobs">, error: string): Promise<void> => {
    await ctx.db.patch("memoryImportJobs", job._id, { error, status: "failed", updatedAt: Date.now() });
    await dropBatches(ctx, job._id);
};

/** Queues a batch of a job and schedules the reaper for it. */
const startBatch = async (ctx: MutationCtx, job: Doc<"memoryImportJobs">, index: number): Promise<void> => {
    await enqueueJob(internal.memory.import_job.runMemoryImportBatch, { index, jobId: job._id }, { shardKey: job.userId });
    await runAfterOnShard(ctx.scheduler, STALE_IMPORT_BATCH_MS, internal.memory.import_job.reapMemoryImportJob, { batch: index, jobId: job._id }, job.userId);
};

/**
 * Creates the job in `preparing`, with the counts the parse already settled: its duplicates, too long and invalid
 * entries are done work. Refused while another import of the user is active.
 */
export const prepareImportJob = internalMutation
    .input({
        batchCount: v.number(),
        duplicates: v.number(),
        invalid: v.number(),
        tooLong: v.number(),
        total: v.number(),
        userId: v.string(),
    })
    .output(v.id("memoryImportJobs"))
    .mutation(async ({ args, ctx }) => {
        if (!(await readMemoryEnabled(ctx, args.userId))) {
            throw new LunoraError("FORBIDDEN", IMPORT_MEMORY_OFF_MESSAGE);
        }

        const recent = await ctx.db
            .query("memoryImportJobs")
            .withIndex("by_userId_createdAt", (q) => q.eq("userId", args.userId))
            .order("desc")
            .take(JOBS_KEPT * 2);

        if (recent.some((job) => ACTIVE.has(job.status))) {
            throw new LunoraError("BAD_REQUEST", IMPORT_RUNNING_MESSAGE);
        }

        // Room for the new one: the oldest of the kept jobs go.
        const surplus = recent.slice(JOBS_KEPT - 1);

        for (const old of surplus) {
            await ctx.db.delete("memoryImportJobs", old._id);
        }

        const now = Date.now();
        const jobId = await ctx.db.insert("memoryImportJobs", {
            batchCount: args.batchCount,
            createdAt: now,
            done: args.duplicates + args.invalid + args.tooLong,
            duplicates: args.duplicates,
            imported: 0,
            invalid: args.invalid,
            nextBatch: 0,
            status: "preparing",
            tooLong: args.tooLong,
            total: args.total,
            updated: 0,
            updatedAt: now,
            userId: args.userId,
        });

        // A start that dies before `beginImportJob` would otherwise block the user's next import for good.
        await runAfterOnShard(ctx.scheduler, STALE_IMPORT_BATCH_MS, internal.memory.import_job.reapMemoryImportJob, { batch: PREPARING, jobId }, args.userId);

        return jobId;
    });

/** Stores a run of batches of a job still preparing. The entries are the user's memories: masked in the logs. */
export const storeImportBatches = internalMutation
    .input({
        batches: v.sensitive(v.array(v.array(vEntry))),
        firstIndex: v.number(),
        jobId: v.id("memoryImportJobs"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job || job.userId !== args.userId || job.status !== "preparing") {
            throw new LunoraError("BAD_REQUEST", "The import is no longer preparing.");
        }

        for (const [offset, entries] of args.batches.entries()) {
            await ctx.db.insert("memoryImportBatches", { entries, index: args.firstIndex + offset, jobId: args.jobId, userId: args.userId });
        }

        return null;
    });

/** Starts a prepared job: its first batch goes on the jobs queue. */
export const beginImportJob = internalMutation
    .input({ jobId: v.id("memoryImportJobs"), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job || job.userId !== args.userId || job.status !== "preparing") {
            throw new LunoraError("BAD_REQUEST", "The import is no longer preparing.");
        }

        await ctx.db.patch("memoryImportJobs", job._id, { status: "queued", updatedAt: Date.now() });
        await startBatch(ctx, job, 0);

        return null;
    });

/**
 * Claims batch `index` of a job and hands back its entries. `null` means it is not this delivery's to run: the job
 * ended, the batch is not the next one, or a delivery already claimed it. A job whose owner turned memory off or is
 * being deleted ends here, so nothing is written for it.
 */
export const claimImportBatch = internalMutation
    .input({ index: v.number(), jobId: v.id("memoryImportJobs") })
    .output(v.union(v.null(), v.object({ entries: v.sensitive(v.array(vEntry)), userId: v.string() })))
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job || (job.status !== "queued" && job.status !== "running") || job.nextBatch !== args.index || job.claimedBatch === args.index) {
            return null;
        }

        if (await isAccountDeletionUnderway(ctx, job.userId)) {
            await failJob(ctx, job, CANCELLED_MESSAGE);

            return null;
        }

        if (!(await readMemoryEnabled(ctx, job.userId))) {
            await failJob(ctx, job, IMPORT_MEMORY_OFF_MESSAGE);

            return null;
        }

        const batch = await ctx.db
            .query("memoryImportBatches")
            .withIndex("by_jobId_index", (q) => q.eq("jobId", job._id).eq("index", args.index))
            .first();

        if (!batch) {
            await failJob(ctx, job, FAILED_MESSAGE);

            return null;
        }

        await ctx.db.patch("memoryImportJobs", job._id, { claimedBatch: args.index, status: "running", updatedAt: Date.now() });

        return { entries: batch.entries, userId: job.userId };
    });

/** Adds a claimed batch's counts, deletes its entries, and queues the next batch or finishes the job. */
export const completeImportBatch = internalMutation
    .input({ duplicates: v.number(), imported: v.number(), index: v.number(), invalid: v.number(), jobId: v.id("memoryImportJobs"), updated: v.number() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job || job.status !== "running" || job.nextBatch !== args.index || job.claimedBatch !== args.index) {
            return null;
        }

        const batch = await ctx.db
            .query("memoryImportBatches")
            .withIndex("by_jobId_index", (q) => q.eq("jobId", job._id).eq("index", args.index))
            .first();

        if (batch) {
            await ctx.db.delete("memoryImportBatches", batch._id);
        }

        const last = args.index + 1 >= job.batchCount;
        const counts = {
            done: job.done + (batch?.entries.length ?? 0),
            duplicates: job.duplicates + args.duplicates,
            imported: job.imported + args.imported,
            invalid: job.invalid + args.invalid,
            updated: job.updated + args.updated,
            updatedAt: Date.now(),
        };

        if (last) {
            await ctx.db.patch("memoryImportJobs", job._id, { ...counts, status: "done" });

            return null;
        }

        await ctx.db.patch("memoryImportJobs", job._id, { ...counts, nextBatch: args.index + 1 });
        await startBatch(ctx, job, args.index + 1);

        return null;
    });

/** Ends the job's current batch as failed. A late call for a batch that is no longer current changes nothing. */
export const failImportBatch = internalMutation
    .input({ index: v.number(), jobId: v.id("memoryImportJobs"), message: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (job && ACTIVE.has(job.status) && job.nextBatch === args.index) {
            await failJob(ctx, job, args.message);
        }

        return null;
    });

/** Fails a job that is stuck on `batch` (or still preparing, `-1`): its delivery died without reporting. */
export const reapMemoryImportJob = internalMutation
    .input({ batch: v.number(), jobId: v.id("memoryImportJobs") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job) {
            return null;
        }

        const stuck =
            args.batch === PREPARING ? job.status === "preparing" : (job.status === "queued" || job.status === "running") && job.nextBatch === args.batch;

        if (stuck) {
            await failJob(ctx, job, STALLED_MESSAGE);
        }

        return null;
    });

/** One batch: claim, the paste's labelling check, `importFacts`, then the counts. */
export const runMemoryImportBatch = internalAction
    .input({ index: v.number(), jobId: v.id("memoryImportJobs") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const claim = await ctx.runMutation(internal.memory.import_job.claimImportBatch, args);

        if (!claim) {
            return null;
        }

        try {
            // Entries the labelling rule drops count as invalid, as for an inline file.
            const facts = await keepLabelledEntries(ctx, claim.userId, claim.entries);
            const saved =
                facts.length === 0 ? { added: 0, alreadyKnown: 0, updated: 0 } : await importFacts(ctx, { app: "other", facts, userId: claim.userId });

            await ctx.runMutation(internal.memory.import_job.completeImportBatch, {
                duplicates: saved.alreadyKnown,
                imported: saved.added,
                index: args.index,
                // Whatever did not become a row, a confirmation or a merge: the labelling rule's drops, and a fact the save left out as a secret.
                invalid: claim.entries.length - saved.added - saved.alreadyKnown - saved.updated,
                jobId: args.jobId,
                updated: saved.updated,
            });
        } catch (error) {
            console.error(`[memory/import-job] Batch ${String(args.index)} of job ${args.jobId} failed:`, error);
            await ctx.runMutation(internal.memory.import_job.failImportBatch, {
                index: args.index,
                jobId: args.jobId,
                message: error instanceof LunoraError ? error.message : FAILED_MESSAGE,
            });
        }

        return null;
    });

/** Stops the caller's active import. A batch already running finishes without counting. */
export const cancelMemoryImport = authMutation
    .input({ jobId: v.id("memoryImportJobs") })
    .use(rateLimit("memory/update"))
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const job = await ctx.db.get("memoryImportJobs", args.jobId);

        if (!job || job.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Import not found.");
        }

        if (ACTIVE.has(job.status)) {
            await failJob(ctx, job, CANCELLED_MESSAGE);
        }

        return null;
    });

const vProgress = v.object({
    done: v.number(),
    duplicates: v.number(),
    error: v.optional(v.string()),
    imported: v.number(),
    invalid: v.number(),
    jobId: v.id("memoryImportJobs"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    tooLong: v.number(),
    total: v.number(),
    updated: v.number(),
});

/** The caller's current or most recent import job, or `null`. Counts only: never an entry's text. */
export const getMemoryImportProgress = authQuery
    .input({})
    .output(v.union(v.null(), vProgress))
    .query(async ({ ctx }) => {
        const job = await ctx.db
            .query("memoryImportJobs")
            .withIndex("by_userId_createdAt", (q) => q.eq("userId", ctx.user.userId))
            .order("desc")
            .first();

        if (!job) {
            return null;
        }

        return {
            done: job.done,
            duplicates: job.duplicates,
            ...(job.error !== undefined && { error: job.error }),
            imported: job.imported,
            invalid: job.invalid,
            jobId: job._id,
            status: job.status === "preparing" ? "queued" : job.status,
            tooLong: job.tooLong,
            total: job.total,
            updated: job.updated,
        };
    });
