import { LunoraError, v } from "lunorash/server";

/**
 * Chat import functions — cRPC procedures for importing conversations from
 * external AI chat providers (ChatGPT, Gemini, Claude.ai).
 *
 * Flow:
 *  1. Client parses export file and normalizes conversations.
 *  2. Client uploads the normalized JSON over TUS to the upload route
 *     (`lib/upload-route.ts`), which stages it under the caller's own prefix.
 *  3. Client calls startImportJob with the upload id — this kicks off a
 *     server-side workflow that processes conversations in batches.
 *  4. Client polls getImportStatus for real-time progress.
 */
import { internal } from "../_generated/internal";
import { isUploadId, stagingKeyFor } from "../lib/chat-upload-staging";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getImportStatus = authQuery
    .output(
        v.union(
            v.object({
                _id: v.string(),
                completedAt: v.union(v.number(), v.null()),
                createdAt: v.number(),
                currentStep: v.union(v.string(), v.null()),
                errorMessage: v.union(v.string(), v.null()),
                failedConversations: v.union(v.number(), v.null()),
                importedConversations: v.number(),
                progress: v.union(v.number(), v.null()),
                provider: v.string(),
                status: v.string(),
                totalConversations: v.number(),
            }),
            v.null(),
        ),
    )
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;

        const job = await ctx.db
            .query("chatImportJobs")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
            .order("desc")
            .first();

        if (!job) {
            return null;
        }

        return {
            _id: job._id,
            completedAt: job.completedAt ?? null,
            createdAt: job.createdAt ?? 0,
            currentStep: job.currentStep ?? null,
            errorMessage: job.errorMessage ?? null,
            failedConversations: job.failedConversations ?? null,
            importedConversations: job.importedConversations ?? 0,
            progress: job.progress ?? null,
            provider: job.provider ?? "",
            status: job.status ?? "pending",
            totalConversations: job.totalConversations ?? 0,
        };
    });

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Start a new import job. The client must have already uploaded the normalized
 * conversations JSON to the upload route and passes the upload id here.
 *
 * This mutation creates a tracking record and kicks off a workflow that
 * processes conversations server-side.
 */
export const startImportJob = authMutation
    .use(rateLimit("chat-import/start"))
    .input({
        provider: v.union(v.literal("chatgpt"), v.literal("gemini"), v.literal("claude")),
        totalConversations: v.number(),
        uploadId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ jobId: v.string() }))
    .mutation(async ({ args: input, ctx }) => {
        const { userId } = ctx.user;

        // The workflow reads this object into the caller's threads and then
        // deletes it, so only an object the caller uploaded may be named: the
        // key is rebuilt under the CALLER's staging prefix from the upload id.
        // Another user's upload id names an object of the caller's that does
        // not exist, and the workflow's read fails the job like any missing
        // file — it never reaches anyone else's.
        if (!isUploadId(input.uploadId)) {
            throw new LunoraError("NOT_FOUND", "Upload not found");
        }

        const r2Key = stagingKeyFor(userId, input.uploadId);

        // Check for existing active import
        const existing = await ctx.db
            .query("chatImportJobs")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "processing"))
            .first();

        if (existing) {
            throw new LunoraError("CONFLICT", "An import is already in progress. Please wait for it to complete.");
        }

        const jobId = await ctx.db.insert("chatImportJobs", {
            createdAt: ctx.now,
            currentStep: "uploading",
            failedConversations: 0,
            importedConversations: 0,
            progress: 0,
            provider: input.provider,
            r2Key,
            status: "processing",
            totalConversations: input.totalConversations,
            userId,
        });

        // Schedule the workflow to start immediately
        ctx.scheduler.runAfter(0, internal.chat_import.workflow_actions.startImportWorkflow, {
            jobId,
            provider: input.provider,
            r2Key,
            totalConversations: input.totalConversations,
            userId,
        });

        ctx.log.event("chat.start_import_job", { provider: input.provider, totalConversations: input.totalConversations });

        return { jobId };
    });

/**
 * Cancel an active import job.
 */
export const cancelImportJob = authMutation
    .use(rateLimit("chat-import/start"))
    .input({
        jobId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: input, ctx }) => {
        const { userId } = ctx.user;
        // `jobId` arrives as a wire string; `asId` is the parse boundary that brands it.
        const jobId = ctx.db.asId("chatImportJobs", input.jobId);
        const job = await ctx.db.get(jobId);

        if (!job || job.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Import job not found");
        }

        if (job.status === "processing") {
            await ctx.db.patch(jobId, {
                completedAt: ctx.now,
                errorMessage: "Cancelled by user",
                status: "failed",
            });
        }

        ctx.log.event("chat.cancel_import_job", { cancelled: job.status === "processing" });

        return null;
    });
