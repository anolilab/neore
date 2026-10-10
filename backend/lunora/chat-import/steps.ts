import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { insertMessageRow, insertThread } from "../agent/table-writes";
import { scheduleObjectDeletion } from "../lib/storage-cleanup";
import { MAX_STORED_READ_BYTES as IMPORT_FILE_MAX_BYTES, readStoredText } from "../lib/storage-read";
import { withoutUndefined } from "../lib/patch";
import { notifyQuietly } from "../notifications/notify";

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
        // back from the public bucket URL (`lib/storage-read.ts`).
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

        // 3. Process conversations in batches
        let totalImported = 0;
        let totalFailed = 0;
        const totalBatches = Math.ceil(conversations.length / BATCH_SIZE);

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
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

            const start = batchIndex * BATCH_SIZE;
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
                    provider: args.provider,
                    userId: args.userId,
                });

                totalImported += result.imported;
                totalFailed += result.failed;
            } catch {
                totalFailed += batch.length;
            }

            // Update progress (5% reserved for init, 90% for processing, 5% for cleanup)
            const batchProgress = 5 + Math.round(((batchIndex + 1) / totalBatches) * 90);

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

// ---------------------------------------------------------------------------
// processConversationBatch — mutation that creates threads + messages
// ---------------------------------------------------------------------------
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
                    createdBy: `import:${args.provider}`,
                    status: "active",
                    title: conv.title || "Imported conversation",
                    updatedAt: context.now,
                    userId: args.userId,
                });

                let order = 0;

                for (const message of conv.messages) {
                    if (message.role === "user") {
                        order += 1;
                    }

                    await insertMessageRow(context.db, {
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

        return { failed, imported };
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
        failed: v.number(),
        imported: v.number(),
        jobId: v.id("chatImportJobs"),
        r2Key: v.string(),
        status: v.union(v.literal("completed"), v.literal("failed")),
    })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        // Clean up the R2 import file
        try {
            await scheduleObjectDeletion(context, [args.r2Key]);
        } catch {
            // Non-fatal: file might already be deleted
        }

        // Update the job record
        // Note: set r2Key to "" (empty string) to clear it — `undefined` in a patch does not clear a field
        await context.db.patch(
            args.jobId,
            withoutUndefined({
                completedAt: context.now,
                currentStep: args.status === "completed" ? "done" : "failed",
                errorMessage: args.errorMessage,
                failedConversations: args.failed,
                importedConversations: args.imported,
                progress: 100,
                r2Key: "",
                status: args.status,
            }),
        );

        const job = await context.db.get(args.jobId);

        if (job) {
            await notifyQuietly(context, {
                body: [`${String(args.imported)} conversations imported`, args.errorMessage].filter(Boolean).join(". "),
                dedupeKey: `chat_import:${args.jobId}`,
                link: "/chat",
                outcome: args.status === "completed" ? "success" : "failure",
                title: job.provider,
                type: "chat_import",
                userId: job.userId,
            });
        }

        return null;
    });
