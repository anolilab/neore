/**
 * Server-side workflow that processes an imported chat file stored in R2.
 *
 * On `@lunora/workflow` — durable over Cloudflare Workflows.
 *
 * Steps:
 *  1. `process-import-file` — reads JSON from R2, creates threads/messages in batches
 *  2. `finalize-import`     — deletes the R2 file and marks the job completed/failed
 *
 * **Step 1 is checkpointed; step 2 always runs.** If step 1 throws, the error is
 * caught here rather than allowed to fail the instance, so the cleanup still
 * happens — otherwise a failed import leaves an orphaned R2 object and a job
 * stuck in `processing`. The durable checkpoint means a *transient* failure
 * inside step 1 is retried by the platform first; only a final failure reaches
 * this catch.
 *
 * Step names are stable identifiers in the durable log — renaming one makes
 * in-flight instances resume at the wrong place.
 */
import type { WorkflowConfig } from "@lunora/workflow";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { onUserShard } from "../../lib/workflow-shard";

export interface ImportParams {
    jobId: Id<"chatImportJobs">;
    provider: string;
    r2Key: string;
    totalConversations: number;
    userId: string;
}

export const chatImportWorkflowConfig: WorkflowConfig<ImportParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const { jobId, provider, r2Key, totalConversations, userId } = context.params;

        let imported = 0;
        let failed = 0;
        let errorMessage: string | undefined;

        try {
            const result = (await context.step.do(
                "process-import-file",
                async () => await context.run(internal.chat_import.steps.processImportFile, { jobId, provider, r2Key, totalConversations, userId }),
            )) as { failed: number; imported: number };

            imported = result.imported;
            failed = result.failed;
        } catch (error) {
            failed = totalConversations;
            errorMessage = error instanceof Error ? error.message : "Import processing failed unexpectedly";
        }

        const isAllFailed = imported === 0 && failed > 0;
        let failureSummary: string | undefined;

        if (isAllFailed) {
            failureSummary = `All ${failed} conversations failed to import`;
        } else if (failed > 0) {
            failureSummary = `${failed} conversations failed to import`;
        }

        await context.step.do(
            "finalize-import",
            async () =>
                await context.run(internal.chat_import.steps.finalizeImport, {
                    errorMessage: errorMessage ?? failureSummary,
                    failed,
                    imported,
                    jobId,
                    r2Key,
                    status: isAllFailed ? "failed" : "completed",
                }),
        );
    },
};

export default chatImportWorkflowConfig;
