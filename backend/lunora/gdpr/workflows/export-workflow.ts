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
import { LunoraError } from "lunorash/server";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { onUserShard } from "../../lib/workflow-shard";
import { stepDedupId } from "./dedup-id";
import { collectAllGuides, collectAllPullRequestThreads, collectAllReviewDrafts } from "../../source-control/export-pages";

export interface ExportParams {
    requestId: Id<"gdprRequests">;
    userEmail: string;
    userId: string;
}

/** The user-facing reason a failed export shows; never the raw error. */
export const exportFailureMessage = (error: unknown): string =>
    error instanceof LunoraError && error.code === "PAYLOAD_TOO_LARGE"
        ? "Your export is larger than the 32 MB limit; contact support"
        : "Failed to generate export file";

export const dataExportWorkflowConfig: WorkflowConfig<ExportParams, void> = {
    handler: async (workflowContext): Promise<void> => {
        // Every step works on this user's rows, which live on their shard.
        const context = onUserShard(workflowContext, workflowContext.params.userId);
        const { requestId, userEmail, userId } = context.params;
        // Scoped to this instance, so a fresh instance for the same request collects again.
        const scope = `${requestId}:${context.event.instanceId}`;

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
        const profile = await context.step.do(
            "collect-profile",
            async () => await context.run(internal.gdpr.steps.collectProfile, { userId }, { dedupId: stepDedupId(scope, "collect-profile") }),
        );

        await progress({ currentStep: "collecting_settings", progress: 20 });
        const settings = await context.step.do(
            "collect-settings",
            async () => await context.run(internal.gdpr.steps.collectSettings, { userId }, { dedupId: stepDedupId(scope, "collect-settings") }),
        );

        await progress({ currentStep: "collecting_conversations", progress: 30 });
        const conversations = await context.step.do(
            "collect-conversations",
            async () => await context.run(internal.gdpr.steps.collectConversations, { userId }, { dedupId: stepDedupId(scope, "collect-conversations") }),
        );

        await progress({ currentStep: "collecting_files", progress: 50 });
        const files = await context.step.do(
            "collect-files",
            async () => await context.run(internal.gdpr.steps.collectFiles, { userId }, { dedupId: stepDedupId(scope, "collect-files") }),
        );

        await progress({ currentStep: "collecting_prompts", progress: 60 });
        const prompts = await context.step.do(
            "collect-prompts",
            async () => await context.run(internal.gdpr.steps.collectPrompts, { userId }, { dedupId: stepDedupId(scope, "collect-prompts") }),
        );

        const threadTags = await context.step.do(
            "collect-thread-tags",
            async () => await context.run(internal.gdpr.steps.collectThreadTags, { userId }, { dedupId: stepDedupId(scope, "collect-thread-tags") }),
        );

        const tasks = await context.step.do(
            "collect-tasks",
            async () => await context.run(internal.tasks.gdpr.collectTasksForExport, { userId }, { dedupId: stepDedupId(scope, "collect-tasks") }),
        );
        const memories = await context.step.do(
            "collect-memories",
            async () => await context.run(internal.memory.gdpr.collectMemoriesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-memories") }),
        );
        const evals = await context.step.do(
            "collect-evals",
            async () => await context.run(internal.evals.gdpr.collectEvalsForExport, { userId }, { dedupId: stepDedupId(scope, "collect-evals") }),
        );
        const triggers = await context.step.do(
            "collect-triggers",
            async () => await context.run(internal.triggers.gdpr.collectTriggersForExport, { userId }, { dedupId: stepDedupId(scope, "collect-triggers") }),
        );
        // A page per step, so no checkpoint outgrows the log's size limit however many drafts there are. The first
        // step keeps the old name: an in-flight run's recorded result has no cursor and reads as the only page.
        const reviewDrafts = await collectAllReviewDrafts(async (cursor, page) => {
            const name = page === 0 ? "collect-review-drafts" : `collect-review-drafts-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(internal.source_control.gdpr.collectReviewDraftsForExport, { cursor, userId }, { dedupId: stepDedupId(scope, name) }),
            );
        });
        const pullRequestGuides = await collectAllGuides(async (cursor, page) => {
            const name = `collect-pull-request-guides-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(
                        internal.source_control.gdpr.collectGuidesForExport,
                        { cursor, userId },
                        { dedupId: stepDedupId(scope, "collect-pull-request-guides", page) },
                    ),
            );
        });
        const pullRequestThreads = await collectAllPullRequestThreads(async (cursor, page) => {
            const name = `collect-pull-request-threads-${String(page)}`;

            return await context.step.do(
                name,
                async () =>
                    await context.run(
                        internal.source_control.gdpr.collectPullRequestThreadsForExport,
                        { cursor, userId },
                        { dedupId: stepDedupId(scope, "collect-pull-request-threads", page) },
                    ),
            );
        });
        const watchedRepositories = await context.step.do(
            "collect-watched-repositories",
            // An id of its own: a replay skips finished steps, which shifts the body's positional dispatch ids.
            async () =>
                await context.run(
                    internal.source_control.gdpr.collectWatchedRepositoriesForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-watched-repositories") },
                ),
        );
        const bots = await context.step.do(
            "collect-bots",
            async () => await context.run(internal.bots.gdpr.collectBotsForExport, { userId }, { dedupId: stepDedupId(scope, "collect-bots") }),
        );
        const codingAgentRuns = await context.step.do(
            "collect-coding-agent-runs",
            async () =>
                await context.run(
                    internal.coding_agents.gdpr.collectCodingAgentRunsForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-coding-agent-runs") },
                ),
        );

        const notifications = await context.step.do(
            "collect-notifications",
            async () =>
                await context.run(
                    internal.notifications.gdpr.collectNotificationsForExport,
                    { userId },
                    { dedupId: stepDedupId(scope, "collect-notifications") },
                ),
        );
        const pages = await context.step.do(
            "collect-pages",
            async () => await context.run(internal.pages.gdpr.collectPagesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-pages") }),
        );
        const devices = await context.step.do(
            "collect-devices",
            async () => await context.run(internal.devices.gdpr.collectDevicesForExport, { userId }, { dedupId: stepDedupId(scope, "collect-devices") }),
        );
        const activity = await context.step.do(
            "collect-activity",
            async () => await context.run(internal.gdpr.steps.collectActivityForExport, { userId }, { dedupId: stepDedupId(scope, "collect-activity") }),
        );

        await progress({ currentStep: "generating_export", progress: 80 });
        // `context.run` is typed `Promise<unknown>` — the runner does not thread a
        // function's return type through — so `step.do` infers `unknown` and the
        // guard below narrows it to `{}`. Cast at the boundary, same as
        // `chat-import/workflows/import-workflow.ts` does. The value is the R2
        // object key `generateExportFile` returns.
        const failExport = async (message: string): Promise<void> => {
            await progress({ errorMessage: message, progress: 80, status: "failed" });
            await context.step.do(
                "notify-export-failed",
                async () =>
                    await context.run(
                        internal.notifications.functions.createNotification,
                        {
                            body: message,
                            dedupeKey: `data_export:${requestId}`,
                            link: "/dashboard/settings/privacy",
                            outcome: "failure",
                            title: "Data export",
                            type: "data_export",
                            userId,
                        },
                        { dedupId: stepDedupId(scope, "notify-export-failed") },
                    ),
            );
        };

        let storageId: Id<"_storage"> | undefined;

        try {
            storageId = (await context.step.do(
                "generate-export-file",
                async () =>
                    await context.run(
                        internal.gdpr.steps.generateExportFile,
                        {
                            activity,
                            bots,
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
                            pullRequestGuides,
                            pullRequestThreads,
                            requestId,
                            reviewDrafts,
                            settings,
                            tasks,
                            threadTags,
                            triggers,
                            userEmail,
                            userId,
                            watchedRepositories,
                        },
                        { dedupId: stepDedupId(scope, "generate-export-file") },
                    ),
            )) as Id<"_storage"> | undefined;
        } catch (error) {
            // Do not rethrow: the row is already failed, and a rethrow would make the runtime retry the whole handler.
            await failExport(exportFailureMessage(error));

            return;
        }

        if (!storageId) {
            await failExport("Failed to generate export file");

            return;
        }

        await progress({ currentStep: "sending_notification", progress: 90 });
        await progress({ progress: 100, status: "completed", storageId });

        await context.step.do(
            "notify-export-ready",
            async () =>
                await context.run(
                    internal.notifications.functions.createNotification,
                    {
                        dedupeKey: `data_export:${requestId}`,
                        link: "/dashboard/settings/privacy",
                        outcome: "success",
                        title: "Data export",
                        type: "data_export",
                        userId,
                    },
                    { dedupId: stepDedupId(scope, "notify-export-ready") },
                ),
        );
        await context.step.do(
            "send-ready-email",
            async () =>
                await context.run(internal.gdpr.steps.sendExportReadyEmail, { requestId, userEmail }, { dedupId: stepDedupId(scope, "send-ready-email") }),
        );

        await context.step.do(
            "log-audit",
            async () =>
                await context.run(
                    internal.gdpr.functions.logAudit,
                    {
                        action: "export_completed",
                        details: JSON.stringify({ requestId }),
                        performedBy: "system",
                        userId,
                    },
                    { dedupId: stepDedupId(scope, "log-audit") },
                ),
        );
    },
};

export default dataExportWorkflowConfig;
