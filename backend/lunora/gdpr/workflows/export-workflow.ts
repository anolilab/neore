/**
 * GDPR data export.
 *
 * On `@lunora/workflow` — a real durable workflow over Cloudflare Workflows, not
 * the scheduler shim this file briefly used. Every `ctx.step.do(name, …)` is a
 * checkpoint: if the isolate dies between "collect files" and "generate export",
 * the retry resumes at "generate export" with the earlier results replayed from
 * the durable log rather than recollected.
 *
 * That matters here specifically. The collect steps are expensive reads over a
 * user's whole history, and `generateExportFile` writes to R2 — re-running the
 * whole thing on a transient failure would cost the reads again and risk a second
 * orphaned object.
 *
 * Step names are stable identifiers in the durable log. Renaming one makes
 * in-flight instances resume at the wrong place, so treat them as a contract.
 */
import type { WorkflowConfig } from "@lunora/workflow";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { onUserShard } from "../../lib/workflow-shard";

export interface ExportParams {
    requestId: Id<"gdprRequests">;
    userEmail: string;
    userId: string;
}

export const dataExportWorkflowConfig: WorkflowConfig<ExportParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const { requestId, userEmail, userId } = context.params;

        /** Progress writes are deliberately NOT checkpointed — idempotent and cheap. */
        const progress = async (patch: {
            currentStep?: string;
            errorMessage?: string;
            progress?: number;
            status?: "cancelled" | "completed" | "failed" | "pending" | "processing";
            storageId?: Id<"_storage">;
        }): Promise<void> => {
            await context.run(internal.gdpr.functions.updateRequestProgress, { requestId, ...patch });
        };

        await progress({ currentStep: "collecting_profile", progress: 10, status: "processing" });
        const profile = await context.step.do("collect-profile", async () => await context.run(internal.gdpr.steps.collectProfile, { userId }));

        await progress({ currentStep: "collecting_settings", progress: 20 });
        const settings = await context.step.do("collect-settings", async () => await context.run(internal.gdpr.steps.collectSettings, { userId }));

        await progress({ currentStep: "collecting_conversations", progress: 30 });
        const conversations = await context.step.do(
            "collect-conversations",
            async () => await context.run(internal.gdpr.steps.collectConversations, { userId }),
        );

        await progress({ currentStep: "collecting_files", progress: 50 });
        const files = await context.step.do("collect-files", async () => await context.run(internal.gdpr.steps.collectFiles, { userId }));

        await progress({ currentStep: "collecting_prompts", progress: 60 });
        const prompts = await context.step.do("collect-prompts", async () => await context.run(internal.gdpr.steps.collectPrompts, { userId }));

        const threadTags = await context.step.do("collect-thread-tags", async () => await context.run(internal.gdpr.steps.collectThreadTags, { userId }));

        const tasks = await context.step.do("collect-tasks", async () => await context.run(internal.tasks.gdpr.collectTasksForExport, { userId }));
        const memories = await context.step.do("collect-memories", async () => await context.run(internal.memory.gdpr.collectMemoriesForExport, { userId }));
        const evals = await context.step.do("collect-evals", async () => await context.run(internal.evals.gdpr.collectEvalsForExport, { userId }));
        const codingAgentRuns = await context.step.do(
            "collect-coding-agent-runs",
            async () => await context.run(internal.coding_agents.gdpr.collectCodingAgentRunsForExport, { userId }),
        );

        const notifications = await context.step.do(
            "collect-notifications",
            async () => await context.run(internal.notifications.gdpr.collectNotificationsForExport, { userId }),
        );
        const pages = await context.step.do("collect-pages", async () => await context.run(internal.pages.gdpr.collectPagesForExport, { userId }));
        const devices = await context.step.do("collect-devices", async () => await context.run(internal.devices.gdpr.collectDevicesForExport, { userId }));
        const activity = await context.step.do("collect-activity", async () => await context.run(internal.gdpr.steps.collectActivityForExport, { userId }));

        await progress({ currentStep: "generating_export", progress: 80 });
        // `context.run` is typed `Promise<unknown>` — the runner does not thread a
        // function's return type through — so `step.do` infers `unknown` and the
        // guard below narrows it to `{}`. Cast at the boundary, same as
        // `chat-import/workflows/import-workflow.ts` does. The value is the R2
        // object key `generateExportFile` returns.
        const storageId = (await context.step.do(
            "generate-export-file",
            async () =>
                await context.run(internal.gdpr.steps.generateExportFile, {
                    activity,
                    codingAgentRuns,
                    conversations,
                    devices,
                    evals,
                    files,
                    memories,
                    notifications,
                    pages,
                    profile,
                    prompts,
                    requestId,
                    settings,
                    tasks,
                    threadTags,
                    userEmail,
                    userId,
                }),
        )) as Id<"_storage"> | undefined;

        if (!storageId) {
            await progress({ errorMessage: "Failed to generate export file", progress: 80, status: "failed" });
            await context.step.do(
                "notify-export-failed",
                async () =>
                    await context.run(internal.notifications.functions.createNotification, {
                        body: "Failed to generate export file",
                        dedupeKey: `data_export:${requestId}`,
                        link: "/dashboard/settings/privacy",
                        outcome: "failure",
                        title: "Data export",
                        type: "data_export",
                        userId,
                    }),
            );

            return;
        }

        await progress({ currentStep: "sending_notification", progress: 90 });
        await progress({ progress: 100, status: "completed", storageId });

        await context.step.do(
            "notify-export-ready",
            async () =>
                await context.run(internal.notifications.functions.createNotification, {
                    dedupeKey: `data_export:${requestId}`,
                    link: "/dashboard/settings/privacy",
                    outcome: "success",
                    title: "Data export",
                    type: "data_export",
                    userId,
                }),
        );
        await context.step.do("send-ready-email", async () => await context.run(internal.gdpr.steps.sendExportReadyEmail, { requestId, userEmail }));

        await context.step.do(
            "log-audit",
            async () =>
                await context.run(internal.gdpr.functions.logAudit, {
                    action: "export_completed",
                    details: JSON.stringify({ requestId }),
                    performedBy: "system",
                    userId,
                }),
        );
    },
};

export default dataExportWorkflowConfig;
