import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { insertMessageRow, insertThread } from "../agent/table-writes";
import { assertStagedChatJson } from "../lib/chat-upload";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { MAX_STORED_READ_BYTES as IMPORT_FILE_MAX_BYTES, readStoredObject, readStoredText } from "../lib/storage-read";
import { withoutUndefined } from "../lib/patch";
import { notifyQuietly } from "../notifications/notify";
import { CANCELLED_IMPORT_MESSAGE, hasConversationsLeft, keptImportKeyFor, RESTART_WINDOW_MS } from "./restart";

const BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Types (matching the normalized format from the frontend parsers)
// ---------------------------------------------------------------------------
interface ImportMessage {
    content: string;
    createdAt?: number;
    role: "user" | "assistant";
}

interface ImportConversation {
    createdAt?: number;
    messages: ImportMessage[];
    title: string;
}

// ---------------------------------------------------------------------------
// checkJobCancelled — query to detect user cancellation between batches
// ---------------------------------------------------------------------------
export const checkJobCancelled = internalQuery
    .input({ jobId: v.id("chatImportJobs") })
    .output(v.boolean())
    .query(async ({ args, ctx: context }) => {
        const job = await context.db.get(args.jobId);

        return !job || job.status === "failed";
    });

// ---------------------------------------------------------------------------
// processImportFile — action that reads from R2 and drives batch processing
// ---------------------------------------------------------------------------
export const processImportFile = internalAction
    .input({
        jobId: v.id("chatImportJobs"),
        provider: v.string(),
        r2Key: v.string(),
        totalConversations: v.number(),
        userId: v.string(),
    })
    .action(async ({ args, ctx: context }) => {
        // 1. Read the import file through `ctx.storage` — it used to be fetched
        // back from the public bucket URL (`lib/storage-read.ts`). First check it
        // is a chat upload of JSON within the document cap: nothing else is read whole.
        await assertStagedChatJson(context, args.r2Key);

        const conversations = JSON.parse(await readStoredText(context.storage, args.r2Key, { maxBytes: IMPORT_FILE_MAX_BYTES })) as ImportConversation[];

        if (!Array.isArray(conversations) || conversations.length === 0) {
            throw new LunoraError("BAD_REQUEST", "Import file contains no conversations");
        }

        // 2. Update total count (in case it differs from estimate)
        await context.runMutation(internal.chat_import.steps.updateImportProgress, {
            currentStep: "processing_conversations",
            jobId: args.jobId,
            progress: 5,
            totalConversations: conversations.length,
        });

        // 3. Process conversations in batches. The counts already saved on the job are the
        // conversations done by an earlier run (a step retry or a restart), so this resumes after them.
        const saved = await context.runQuery(internal.chat_import.steps.importCounts, { jobId: args.jobId });
        let totalImported = saved.imported;
        let totalFailed = saved.failed;
        const resumeFrom = totalImported + totalFailed;

        for (let start = resumeFrom; start < conversations.length; start += BATCH_SIZE) {
            // Check for cancellation before each batch
            const cancelled = await context.runQuery(internal.chat_import.steps.checkJobCancelled, {
                jobId: args.jobId,
            });

            if (cancelled) {
                // User cancelled — count remaining conversations as failed
                const processed = totalImported + totalFailed;

                totalFailed += conversations.length - processed;
                break;
            }

            const batch = conversations.slice(start, start + BATCH_SIZE);

            try {
                const result = await context.runMutation(internal.chat_import.steps.processConversationBatch, {
                    conversations: batch.map((c) => {
                        return {
                            createdAt: c.createdAt,
                            messages: c.messages.map((m) => {
                                return {
                                    content: m.content,
                                    createdAt: m.createdAt,
                                    role: m.role,
                                };
                            }),
                            title: c.title,
                        };
                    }),
                    jobId: args.jobId,
                    provider: args.provider,
                    userId: args.userId,
                });

                totalImported += result.imported;
                totalFailed += result.failed;
            } catch {
                totalFailed += batch.length;
            }

            // Update progress (5% reserved for init, 90% for processing, 5% for cleanup)
            const batchProgress = 5 + Math.round(((start + batch.length) / conversations.length) * 90);

            await context.runMutation(internal.chat_import.steps.updateImportProgress, {
                currentStep: "processing_conversations",
                failedConversations: totalFailed,
                importedConversations: totalImported,
                jobId: args.jobId,
                progress: batchProgress,
            });
        }

        return { failed: totalFailed, imported: totalImported };
    });

/** A source time as a stored one: missing, not positive, or in the future falls back to the import time. */
const trustedTime = (time: number | undefined, now: number): number => (typeof time === "number" && time > 0 && time <= now ? time : now);

/**
 * The latest source time of a conversation, as a stored activity time. A timestamp that is
 * missing, not positive, or in the future is not trusted; the import time stands in for it.
 */
const lastActivityOf = (conv: { createdAt?: number; messages: { createdAt?: number }[] }, now: number): number => {
    const times = [conv.createdAt, ...conv.messages.map((message) => message.createdAt)].filter(
        (time): time is number => typeof time === "number" && time > 0 && time <= now,
    );

    return times.length > 0 ? Math.max(...times) : now;
};

// ---------------------------------------------------------------------------
// processConversationBatch — mutation that creates threads + messages
// ---------------------------------------------------------------------------
/** Add a batch's counts to the job, in the same transaction as the batch's threads. */
const addJobCounts = async (
    context: Pick<MutationCtx, "db">,
    jobId: Id<"chatImportJobs"> | undefined,
    counts: { failed: number; imported: number },
): Promise<void> => {
    if (!jobId) {
        return;
    }

    const job = await context.db.get(jobId);

    if (job) {
        await context.db.patch(jobId, {
            failedConversations: (job.failedConversations ?? 0) + counts.failed,
            importedConversations: job.importedConversations + counts.imported,
        });
    }
};

export const processConversationBatch = internalMutation
    .input({
        conversations: v.array(
            v.object({
                createdAt: v.optional(v.number()),
                messages: v.array(
                    v.object({
                        content: v.string(),
                        createdAt: v.optional(v.number()),
                        role: v.union(v.literal("user"), v.literal("assistant")),
                    }),
                ),
                title: v.string(),
            }),
        ),
        jobId: v.optional(v.id("chatImportJobs")),
        provider: v.string(),
        userId: v.string(),
    })
    .output(v.object({ failed: v.number(), imported: v.number() }))
    .mutation(async ({ args, ctx: context }) => {
        let imported = 0;
        let failed = 0;

        for (const conv of args.conversations) {
            try {
                if (conv.messages.length === 0) {
                    failed += 1;
                    continue;
                }

                // `db.insert` resolves to the branded id itself, not a row.
                const threadId: Id<"threads"> = await insertThread(context.db, {
                    // The sidebar sorts by this, so imported history lands where it was created.
                    createdAt: trustedTime(conv.createdAt, context.now),
                    createdBy: `import:${args.provider}`,
                    status: "active",
                    title: conv.title || "Imported conversation",
                    // Resume, Home's recent threads and the Daily Brief read updatedAt: the source's
                    // latest activity, so a long chat that was active recently is not ranked by its
                    // start date. The sidebar sorts by createdAt above. (_creationTime is system-set
                    // and cannot be written.)
                    updatedAt: lastActivityOf(conv, context.now),
                    userId: args.userId,
                });

                let order = 0;

                for (const message of conv.messages) {
                    if (message.role === "user") {
                        order += 1;
                    }

                    await insertMessageRow(context.db, {
                        createdAt: trustedTime(message.createdAt, context.now),
                        message: {
                            content: message.content,
                            role: message.role,
                        },
                        order,
                        status: "success",
                        stepOrder: message.role === "user" ? 0 : 1,
                        text: message.content,
                        threadId,
                        tool: false,
                        userId: args.userId,
                    });
                }

                imported += 1;
            } catch {
                failed += 1;
            }
        }

        // The counts commit with the threads above, so a retry or a restart resumes after exactly what was saved.
        await addJobCounts(context, args.jobId, { failed, imported });

        return { failed, imported };
    });

/** The conversations a job has already saved or counted as failed. Read before a run, so it resumes after them. */
export const importCounts = internalQuery
    .input({ jobId: v.id("chatImportJobs") })
    .output(v.object({ failed: v.number(), imported: v.number(), total: v.number() }))
    .query(async ({ args, ctx: context }) => {
        const job = await context.db.get(args.jobId);

        return { failed: job?.failedConversations ?? 0, imported: job?.importedConversations ?? 0, total: job?.totalConversations ?? 0 };
    });

/** Whether the job row still exists. Erasure deletes it, and a copy made after that would be left behind. */
export const importJobExists = internalQuery
    .input({ jobId: v.id("chatImportJobs") })
    .output(v.boolean())
    .query(async ({ args, ctx: context }) => (await context.db.get(args.jobId)) !== null);

/**
 * Copy an import's staged file under its kept key before it is processed, so the
 * copy exists however long the import runs: the staging object is reaped an hour
 * after the upload. Only chat JSON is copied, and the check runs on the staging
 * object first, because the copy is written as `application/json`. A restart's
 * file is already the copy, so nothing is written.
 */
export const keepImportFile = internalAction
    .input({ jobId: v.id("chatImportJobs"), r2Key: v.string(), userId: v.string() })
    .output(v.string())
    .action(async ({ args, ctx: context }) => {
        const key = keptImportKeyFor(args.userId, args.jobId);

        if (args.r2Key === key) {
            return key;
        }

        await assertStagedChatJson(context, args.r2Key);

        if (!(await context.runQuery(internal.chat_import.steps.importJobExists, { jobId: args.jobId }))) {
            throw new LunoraError("NOT_FOUND", "Import job not found");
        }

        const stored = await readStoredObject(context.storage, args.r2Key, { maxBytes: IMPORT_FILE_MAX_BYTES });

        await context.storage.store(key, stored.bytes, {
            allowedContentTypes: ["application/json"],
            contentType: "application/json",
            maxSize: IMPORT_FILE_MAX_BYTES,
        });

        // Erasure may have run while the copy was written; the copy is then ours to delete.
        if (!(await context.runQuery(internal.chat_import.steps.importJobExists, { jobId: args.jobId }))) {
            await context.storage.delete(key);

            throw new LunoraError("NOT_FOUND", "Import job not found");
        }

        return key;
    });

/**
 * Delete a failed import's kept file once its restart window has passed. It acts
 * only on the failure it was scheduled for: a restart or a newer failure moves
 * `completedAt` or the key, and then the reap is a no-op.
 */
export const reapRestartableImport = internalMutation
    .input({ failedAt: v.number(), jobId: v.id("chatImportJobs"), r2Key: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const job = await context.db.get(args.jobId);

        if (job && (job.status !== "failed" || job.completedAt !== args.failedAt || job.r2Key !== args.r2Key)) {
            return null;
        }

        if (job) {
            await context.db.patch(args.jobId, { r2Key: "" });
        }

        await scheduleObjectDeletion(context, [args.r2Key]);

        return null;
    });

// ---------------------------------------------------------------------------
// updateImportProgress — mutation to update job progress
// ---------------------------------------------------------------------------
export const updateImportProgress = internalMutation
    .input({
        currentStep: v.optional(v.string()),
        failedConversations: v.optional(v.number()),
        importedConversations: v.optional(v.number()),
        jobId: v.id("chatImportJobs"),
        progress: v.optional(v.number()),
        totalConversations: v.optional(v.number()),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const { jobId, ...updates } = args;
        const patch: {
            currentStep?: string;
            failedConversations?: number;
            importedConversations?: number;
            progress?: number;
            totalConversations?: number;
        } = {};

        if (updates.currentStep !== undefined) {
            patch.currentStep = updates.currentStep;
        }

        if (updates.progress !== undefined) {
            patch.progress = updates.progress;
        }

        if (updates.importedConversations !== undefined) {
            patch.importedConversations = updates.importedConversations;
        }

        if (updates.failedConversations !== undefined) {
            patch.failedConversations = updates.failedConversations;
        }

        if (updates.totalConversations !== undefined) {
            patch.totalConversations = updates.totalConversations;
        }

        await context.db.patch(jobId, withoutUndefined(patch));

        return null;
    });

// ---------------------------------------------------------------------------
// finalizeImport — mutation to clean up R2 file and complete the job
// ---------------------------------------------------------------------------
export const finalizeImport = internalMutation
    .input({
        errorMessage: v.optional(v.string()),
        /** Left out when the run failed before reporting its counts: the counts each batch committed stand. */
        failed: v.optional(v.number()),
        imported: v.optional(v.number()),
        jobId: v.id("chatImportJobs"),
        r2Key: v.string(),
        status: v.union(v.literal("completed"), v.literal("failed")),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const keptKey = keptImportKeyFor(args.userId, args.jobId);
        // The staging object goes unless it is the kept copy itself, which a restart reads.
        const doomed: (string | undefined)[] = [args.r2Key === keptKey ? undefined : args.r2Key];
        const job = await context.db.get(args.jobId);

        if (!job) {
            // Erased while the import ran: nothing refers to these objects any more.
            await scheduleObjectDeletion(context, [...doomed, keptKey]);

            return null;
        }

        // The row decides, not the workflow's view of it: a cancel that landed during the run keeps its marker and is never restartable.
        const cancelled = job.errorMessage === CANCELLED_IMPORT_MESSAGE;
        const imported = args.imported ?? job.importedConversations;
        const failed = args.failed ?? job.failedConversations ?? 0;
        // Kept only when something was committed: a file that failed validation or parsing commits nothing, and a restart would fail the same way.
        const keep =
            args.status === "failed" &&
            !cancelled &&
            imported + failed > 0 &&
            hasConversationsLeft({ failedConversations: failed, importedConversations: imported, totalConversations: job.totalConversations });

        if (!keep) {
            doomed.push(keptKey);
        }

        try {
            await scheduleObjectDeletion(context, doomed);
        } catch {
            // Non-fatal: file might already be deleted
        }

        const status = cancelled ? "failed" : args.status;
        const errorMessage = cancelled ? job.errorMessage : args.errorMessage;

        // Note: set r2Key to "" (empty string) to clear it — `undefined` in a patch does not clear a field
        await context.db.patch(
            args.jobId,
            withoutUndefined({
                completedAt: context.now,
                currentStep: status === "completed" ? "done" : "failed",
                errorMessage,
                failedConversations: failed,
                importedConversations: imported,
                progress: 100,
                r2Key: keep ? keptKey : "",
                status,
            }),
        );

        if (keep) {
            await context.scheduler.runAfter(RESTART_WINDOW_MS, internal.chat_import.steps.reapRestartableImport, {
                failedAt: context.now,
                jobId: args.jobId,
                r2Key: keptKey,
            });
        }

        await notifyQuietly(context, {
            body: [`${String(imported)} conversations imported`, errorMessage].filter(Boolean).join(". "),
            dedupeKey: `chat_import:${args.jobId}`,
            link: "/chat",
            outcome: status === "completed" ? "success" : "failure",
            title: job.provider,
            type: "chat_import",
            userId: job.userId,
        });

        return null;
    });
